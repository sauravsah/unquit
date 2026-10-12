/**
 * Clawbacks and Stripe-dispute holds.
 *
 *   charge.refunded / credit notes   the fee lines earned on that invoice are
 *                                    reversed pro-rata to what went back
 *   charge.dispute.* (open)          those fee lines are HELD (not billed)
 *   charge.dispute.closed: lost      reversed (pro-rata to the disputed amount)
 *   charge.dispute.closed: won       hold released, the fee stands
 *
 * Each Stripe source (a charge's refunds, a credit note, a lost dispute) is
 * stored with its CUMULATIVE amount in invoice_reversals, and every line's
 * clawback is recomputed from the sum. Re-delivered, out-of-order and
 * overlapping events (a credit note's refund also fires charge.refunded) can
 * therefore never count money twice. Clawbacks only ever grow: unquit never
 * re-charges a fee because a credit note was voided.
 */
import { refreshSaveFee } from "@/lib/saves/verify";
import { netCents, proRataClawbackCents } from "./fees";
import type { ClawbackKind, FeeLineRow, LedgerRepo, ReversalKind, SaveEventKind } from "./types";

export type ReversalInput = {
  invoiceId: string;
  /** charge:<ch_…> | credit_note:<cn_…> | dispute:<dp_…> */
  sourceKey: string;
  kind: ReversalKind;
  /** Cumulative amount this source returned to the customer. */
  amountCents: number;
  /** The invoice's amount paid, when the event knows it (used if the line doesn't). */
  paidCentsHint?: number | null;
};

export type ReversalResult = {
  matched: boolean;
  /** Total newly clawed back by this call, across lines. */
  clawedBackCents: number;
  lines: { lineId: string; saveId: string; deltaCents: number; totalCents: number }[];
};

const EVENT_FOR: Record<ReversalKind, SaveEventKind> = {
  refund: "refund",
  credit_note: "credit_note",
  dispute_lost: "stripe_dispute_lost",
};

/**
 * Records what a Stripe source returned on an invoice and claws back the
 * fee lines that invoice earned. `lookupPaidCents` is only called when neither
 * the line nor the event knows what the invoice paid.
 */
export async function applyInvoiceReversal(
  repo: LedgerRepo,
  accountId: string,
  input: ReversalInput,
  now: Date,
  lookupPaidCents?: () => Promise<number | null>,
): Promise<ReversalResult> {
  const lines = await repo.linesForInvoice(accountId, input.invoiceId);
  if (lines.length === 0) return { matched: false, clawedBackCents: 0, lines: [] };

  await repo.upsertReversal({
    account_id: accountId,
    stripe_invoice_id: input.invoiceId,
    source_key: input.sourceKey,
    kind: input.kind,
    amount_cents: Math.max(0, Math.trunc(input.amountCents)),
  });
  const returnedCents = (await repo.reversalsForInvoice(accountId, input.invoiceId)).reduce((a, r) => a + Number(r.amount_cents), 0);

  let looked: number | null | undefined;
  const result: ReversalResult = { matched: true, clawedBackCents: 0, lines: [] };
  const touchedSaves = new Set<string>();

  for (const line of lines) {
    let paid = line.invoice_amount_paid_cents ?? input.paidCentsHint ?? null;
    if (paid === null && lookupPaidCents) {
      if (looked === undefined) looked = await lookupPaidCents().catch(() => null);
      paid = looked;
    }
    // Unknown invoice amount: be conservative for the founder and reverse it all.
    const target = paid === null ? Number(line.amount_cents) : proRataClawbackCents(Number(line.amount_cents), returnedCents, Number(paid));
    const delta = await raiseClawback(repo, line, target, input.kind, input.sourceKey);
    if (delta > 0) {
      result.clawedBackCents += delta;
      result.lines.push({ lineId: line.id, saveId: line.save_id, deltaCents: delta, totalCents: target });
      touchedSaves.add(line.save_id);
      await repo.addEvent({
        accountId,
        saveId: line.save_id,
        kind: EVENT_FOR[input.kind],
        detail: {
          invoice: input.invoiceId,
          source: input.sourceKey,
          month_index: line.month_index,
          clawed_back_cents: delta,
          returned_cents: returnedCents,
          paid_cents: paid,
        },
        dedupeKey: `${input.kind}:${line.id}:${target}`,
        occurredAt: now.toISOString(),
      });
    }
  }

  for (const saveId of touchedSaves) await settleSaveAfterClawback(repo, saveId, now);
  return result;
}

/**
 * Raises a line's clawed_back_cents to `targetCents` (never lowers it) and
 * logs the difference. Compare-and-set with a re-read, so two concurrent
 * events add up instead of overwriting each other. Returns the delta.
 */
export async function raiseClawback(
  repo: LedgerRepo,
  line: FeeLineRow,
  targetCents: number,
  kind: ClawbackKind,
  source: string | null,
): Promise<number> {
  let current = line;
  for (let attempt = 0; attempt < 5; attempt++) {
    const from = Number(current.clawed_back_cents ?? 0);
    const to = Math.min(Number(current.amount_cents), Math.max(from, targetCents));
    if (to <= from) return 0;
    if (await repo.casClawedBack(current.id, from, to, to >= Number(current.amount_cents))) {
      await repo.insertClawback({
        account_id: current.account_id,
        save_id: current.save_id,
        fee_line_id: current.id,
        kind,
        source,
        amount_cents: to - from,
      });
      return to - from;
    }
    const fresh = (await repo.linesForSave(current.save_id)).find((l) => l.id === current.id);
    if (!fresh) return 0;
    current = fresh;
  }
  throw new Error(`Clawback on fee line ${line.id} kept conflicting; the webhook will retry`);
}

/** Updates fee_cents and, when every line is fully reversed, marks the save clawed_back. */
export async function settleSaveAfterClawback(repo: LedgerRepo, saveId: string, now: Date): Promise<void> {
  const remaining = await refreshSaveFee(repo, saveId);
  const lines = await repo.linesForSave(saveId);
  if (lines.length > 0 && remaining === 0 && lines.every((l) => netCents(l) === 0)) {
    // A save under a founder dispute keeps its 'disputed' status until the dispute is resolved.
    await repo.setSaveStatus(saveId, ["verified"], "clawed_back", { clawed_back_at: now.toISOString() });
  }
}

// -----------------------------------------------------------------------------
// Stripe disputes (chargebacks)
// -----------------------------------------------------------------------------

/** Stripe dispute statuses where the money is still in question. */
const OPEN_DISPUTE = new Set(["needs_response", "under_review", "warning_needs_response", "warning_under_review"]);
/** Closed in the merchant's favour (or never became a chargeback). */
const DISPUTE_WON = new Set(["won", "warning_closed", "prevented"]);

export type StripeDisputeInput = {
  disputeId: string;
  invoiceId: string;
  status: string;
  /** The disputed amount. */
  amountCents: number;
  paidCentsHint?: number | null;
};

export type DisputeOutcome = "held" | "released" | "reversed" | "unmatched" | "ignored";

export async function handleStripeDispute(
  repo: LedgerRepo,
  accountId: string,
  input: StripeDisputeInput,
  now: Date,
  lookupPaidCents?: () => Promise<number | null>,
): Promise<DisputeOutcome> {
  const lines = await repo.linesForInvoice(accountId, input.invoiceId);
  if (lines.length === 0) return "unmatched";
  const saveIds = [...new Set(lines.map((l) => l.save_id))];

  if (OPEN_DISPUTE.has(input.status)) {
    await repo.holdLinesForInvoice(accountId, input.invoiceId, input.disputeId);
    for (const saveId of saveIds) {
      await repo.addEvent({
        accountId,
        saveId,
        kind: "stripe_dispute_opened",
        detail: { dispute: input.disputeId, invoice: input.invoiceId, amount_cents: input.amountCents },
        dedupeKey: `stripe_dispute_opened:${saveId}:${input.disputeId}`,
        occurredAt: now.toISOString(),
      });
    }
    return "held";
  }

  if (DISPUTE_WON.has(input.status)) {
    await repo.releaseStripeHold(accountId, input.disputeId);
    for (const saveId of saveIds) {
      await repo.addEvent({
        accountId,
        saveId,
        kind: "stripe_dispute_won",
        detail: { dispute: input.disputeId, invoice: input.invoiceId, status: input.status },
        dedupeKey: `stripe_dispute_won:${saveId}:${input.disputeId}`,
        occurredAt: now.toISOString(),
      });
    }
    return "released";
  }

  if (input.status === "lost") {
    await applyInvoiceReversal(
      repo,
      accountId,
      {
        invoiceId: input.invoiceId,
        sourceKey: `dispute:${input.disputeId}`,
        kind: "dispute_lost",
        amountCents: input.amountCents,
        paidCentsHint: input.paidCentsHint,
      },
      now,
      lookupPaidCents,
    );
    // Whatever wasn't reversed (a partial dispute) can be billed again.
    await repo.releaseStripeHold(accountId, input.disputeId);
    return "reversed";
  }

  return "ignored";
}

/** The part of a credit note that is NOT a refund (refunds arrive as charge.refunded). */
export function creditNoteNonRefundCents(note: {
  status: string;
  post_payment_amount?: number | null;
  refunds?: { amount_refunded: number }[] | null;
}): number {
  if (note.status === "void") return 0;
  const post = Number(note.post_payment_amount ?? 0);
  const refunded = (note.refunds ?? []).reduce((a, r) => a + Number(r.amount_refunded ?? 0), 0);
  return Math.max(0, post - refunded);
}
