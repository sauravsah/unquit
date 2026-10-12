/**
 * Founder disputes: the "Dispute this save" button on a receipt.
 *
 *   1. The dispute is stored and every fee line of the save is HELD (not
 *      billed) while it is open. The save shows as "disputed".
 *   2. Auto-rules check the evidence in Stripe straight away. If the proof
 *      doesn't hold up (no paid invoice, the invoice was refunded, or it isn't
 *      on that subscription / customer), the dispute is resolved in the
 *      founder's favour automatically and the fees are reversed.
 *   3. Anything else goes to the admin review queue (/admin). Accept = fees
 *      reversed; reject = holds released, fees stand. Either way the founder
 *      sees the outcome on the receipt and gets an email.
 */
import { raiseClawback, settleSaveAfterClawback } from "./clawbacks";
import { adminDisputeEmail, disputeOutcomeEmail, receiptEmail, DISPUTE_CATEGORY_LABELS, type RenderedEmail } from "./emails";
import { refreshSaveFee } from "@/lib/saves/verify";
import type { DisputeCategory, DisputeRow, LedgerRepo, SaveRow } from "./types";

export const DISPUTE_CATEGORIES = Object.keys(DISPUTE_CATEGORY_LABELS) as DisputeCategory[];
export const MAX_NOTE = 2000;

/** What Stripe says about an invoice that earned a fee line. */
export type InvoiceEvidence = {
  id: string;
  status: string | null;
  amountPaidCents: number;
  subscriptionId: string | null;
  customerId: string | null;
  /** Refunds + post-payment credit notes. */
  refundedCents: number;
};

export interface EvidenceStripe {
  /** null when the invoice doesn't exist on that connected account. */
  getInvoiceEvidence(stripeAccount: string, invoiceId: string): Promise<InvoiceEvidence | null>;
}

export interface FounderMailer {
  /** Emails the account's owner. False when there was nobody to send to. */
  toFounder(accountId: string, email: RenderedEmail & { idempotencyKey: string }): Promise<boolean>;
  /** Emails everyone in ADMIN_EMAILS (best effort). */
  toAdmins(email: RenderedEmail & { idempotencyKey: string }): Promise<void>;
}

export type LedgerDeps = {
  repo: LedgerRepo;
  stripe?: EvidenceStripe;
  mailer?: FounderMailer;
  appUrl: string;
  now?: () => Date;
  log?: (line: string) => void;
};

export class DisputeError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export type EvidenceFailure = "no_paid_invoice" | "refunded" | "wrong_subscription" | "wrong_customer";

export type EvidenceReport = {
  checks: {
    invoice: string;
    found: boolean;
    paid: boolean;
    refunded_cents: number;
    subscription_matches: boolean;
    customer_matches: boolean;
  }[];
  failed: EvidenceFailure[];
  error?: string;
};

export const EVIDENCE_LABELS: Record<EvidenceFailure, string> = {
  no_paid_invoice: "No paid invoice backs this save",
  refunded: "The invoice was refunded",
  wrong_subscription: "The invoice isn't on the saved subscription",
  wrong_customer: "The invoice belongs to a different customer",
};

export const receiptUrl = (appUrl: string, receiptNumber: string) => `${appUrl}/dashboard/saves/${encodeURIComponent(receiptNumber)}`;

/** Pure: turns the Stripe lookups into pass/fail checks. */
export function evaluateEvidence(
  save: Pick<SaveRow, "stripe_subscription_id" | "stripe_customer_id">,
  invoiceIds: string[],
  found: Map<string, InvoiceEvidence | null>,
  locallyReturnedCents: Map<string, number> = new Map(),
): EvidenceReport {
  const report: EvidenceReport = { checks: [], failed: [] };
  const failed = new Set<EvidenceFailure>();
  if (invoiceIds.length === 0) failed.add("no_paid_invoice");
  for (const id of invoiceIds) {
    const ev = found.get(id) ?? null;
    const refunded = Math.max(ev?.refundedCents ?? 0, locallyReturnedCents.get(id) ?? 0);
    const check = {
      invoice: id,
      found: !!ev,
      paid: !!ev && ev.status === "paid" && ev.amountPaidCents > 0,
      refunded_cents: refunded,
      subscription_matches: !!ev && !!save.stripe_subscription_id && ev.subscriptionId === save.stripe_subscription_id,
      customer_matches: !!ev && ev.customerId === save.stripe_customer_id,
    };
    report.checks.push(check);
    if (!check.paid) failed.add("no_paid_invoice");
    if (refunded > 0) failed.add("refunded");
    if (ev && save.stripe_subscription_id && !check.subscription_matches) failed.add("wrong_subscription");
    if (ev && !check.customer_matches) failed.add("wrong_customer");
  }
  report.failed = [...failed];
  return report;
}

export function parseDisputeInput(input: { category?: unknown; note?: unknown }):
  | { ok: true; category: DisputeCategory; note: string | null }
  | { ok: false; error: string } {
  const category = typeof input.category === "string" ? input.category : "";
  if (!DISPUTE_CATEGORIES.includes(category as DisputeCategory)) return { ok: false, error: "Please choose a reason." };
  const note = typeof input.note === "string" ? input.note.trim() : "";
  if (note.length > MAX_NOTE) return { ok: false, error: `Please keep the note under ${MAX_NOTE} characters.` };
  if (category === "other" && note.length === 0) return { ok: false, error: "Please add a note explaining why." };
  return { ok: true, category: category as DisputeCategory, note: note.length > 0 ? note : null };
}

async function collectEvidence(deps: LedgerDeps, save: SaveRow, stripeAccount: string | null): Promise<EvidenceReport> {
  const lines = await deps.repo.linesForSave(save.id);
  const invoiceIds = [...new Set([save.stripe_invoice_id, ...lines.map((l) => l.stripe_invoice_id)].filter((x): x is string => !!x))];
  const found = new Map<string, InvoiceEvidence | null>();
  const local = new Map<string, number>();
  for (const id of invoiceIds) {
    const reversals = await deps.repo.reversalsForInvoice(save.account_id, id);
    local.set(id, reversals.reduce((a, r) => a + Number(r.amount_cents), 0));
  }
  if (!deps.stripe || !stripeAccount) {
    return { checks: [], failed: [], error: "Stripe is not connected, so the invoices can't be checked automatically." };
  }
  try {
    for (const id of invoiceIds) found.set(id, await deps.stripe.getInvoiceEvidence(stripeAccount, id));
  } catch (error) {
    return { checks: [], failed: [], error: `Stripe lookup failed: ${error instanceof Error ? error.message : String(error)}` };
  }
  return evaluateEvidence(save, invoiceIds, found, local);
}

export type OpenDisputeResult = { dispute: DisputeRow; outcome: "auto_accepted" | "in_review"; evidence: EvidenceReport };

export async function openDispute(
  deps: LedgerDeps,
  input: { accountId: string; receiptSaveId: string; userId: string | null; category: unknown; note: unknown },
): Promise<OpenDisputeResult> {
  const now = deps.now?.() ?? new Date();
  const parsed = parseDisputeInput(input);
  if (!parsed.ok) throw new DisputeError(400, "invalid", parsed.error);

  const save = await deps.repo.getSave(input.receiptSaveId);
  if (!save || save.account_id !== input.accountId) throw new DisputeError(404, "not_found", "We couldn't find that save.");
  if (save.status === "disputed") throw new DisputeError(409, "already_open", "This save already has an open dispute.");
  if (save.status === "pending" || save.status === "lost") {
    throw new DisputeError(409, "no_fee", "This save hasn't been verified, so there's no fee to dispute.");
  }
  if (save.status === "clawed_back") throw new DisputeError(409, "no_fee", "The fee for this save was already reversed.");

  const dispute = await deps.repo.insertDispute({
    save_id: save.id,
    account_id: save.account_id,
    opened_by: input.userId,
    reason: parsed.note ?? DISPUTE_CATEGORY_LABELS[parsed.category],
    category: parsed.category,
    note: parsed.note,
    created_at: now.toISOString(),
  });
  if (!dispute) throw new DisputeError(409, "already_open", "This save already has an open dispute.");

  await deps.repo.setSaveStatus(save.id, ["verified"], "disputed");
  await deps.repo.setFounderHold(save.id, dispute.id);
  await deps.repo.addEvent({
    accountId: save.account_id,
    saveId: save.id,
    kind: "dispute_opened",
    detail: { dispute: dispute.id, category: parsed.category, note: parsed.note },
    dedupeKey: `dispute_opened:${dispute.id}`,
    occurredAt: now.toISOString(),
  });

  const account = await deps.repo.getAccount(save.account_id);
  const evidence = await collectEvidence(deps, save, account?.stripe_account_id ?? null);
  await deps.repo.setDisputeEvidence(dispute.id, evidence as unknown as Record<string, unknown>);

  if (evidence.failed.length > 0) {
    const note = `Automatic check: ${evidence.failed.map((f) => EVIDENCE_LABELS[f]).join("; ")}.`;
    const resolved = await resolveDispute(deps, { disputeId: dispute.id, decision: "accept", note, resolvedBy: "auto-rules", resolution: "auto" });
    return { dispute: resolved, outcome: "auto_accepted", evidence };
  }

  if (deps.mailer) {
    const fresh = (await deps.repo.getDispute(dispute.id)) ?? dispute;
    await deps.mailer
      .toAdmins({ ...adminDisputeEmail(save, fresh, `${deps.appUrl}/admin`), idempotencyKey: `dispute-admin/${dispute.id}` })
      .catch((error) => deps.log?.(`[disputes] admin email failed: ${String(error)}`));
  }
  return { dispute: (await deps.repo.getDispute(dispute.id)) ?? dispute, outcome: "in_review", evidence };
}

/**
 * Accept (fees reversed) or reject (holds released, fees stand). Compare-and-
 * set on the dispute, so a double click or two admins resolve it once.
 */
export async function resolveDispute(
  deps: LedgerDeps,
  input: { disputeId: string; decision: "accept" | "reject"; note: string | null; resolvedBy: string; resolution?: "auto" | "admin" },
): Promise<DisputeRow> {
  const now = deps.now?.() ?? new Date();
  const dispute = await deps.repo.getDispute(input.disputeId);
  if (!dispute) throw new DisputeError(404, "not_found", "Dispute not found.");
  const note = input.note?.trim().slice(0, MAX_NOTE) || null;
  if (input.decision === "reject" && !note) throw new DisputeError(400, "note_required", "Please add a note for the founder.");

  const won = await deps.repo.resolveDispute(dispute.id, {
    status: input.decision === "accept" ? "accepted" : "rejected",
    resolution: input.resolution ?? "admin",
    note,
    resolvedBy: input.resolvedBy,
    at: now.toISOString(),
  });
  if (!won) throw new DisputeError(409, "already_resolved", "This dispute was already resolved.");

  const save = await deps.repo.getSave(dispute.save_id);
  if (!save) throw new DisputeError(404, "not_found", "Save not found.");

  if (input.decision === "accept") {
    const kind = (input.resolution ?? "admin") === "auto" ? "dispute_auto" : "dispute_accepted";
    for (const line of await deps.repo.linesForSave(save.id)) {
      await raiseClawback(deps.repo, line, Number(line.amount_cents), kind, dispute.id);
    }
    await deps.repo.setFounderHold(save.id, null);
    await refreshSaveFee(deps.repo, save.id);
    await deps.repo.setSaveStatus(save.id, ["disputed", "verified"], "clawed_back", { clawed_back_at: now.toISOString() });
  } else {
    await deps.repo.setFounderHold(save.id, null);
    await deps.repo.setSaveStatus(save.id, ["disputed"], "verified");
    // A refund that landed while the dispute was open may have reversed everything.
    await settleSaveAfterClawback(deps.repo, save.id, now);
  }

  await deps.repo.addEvent({
    accountId: save.account_id,
    saveId: save.id,
    kind: input.decision === "accept" ? "dispute_accepted" : "dispute_rejected",
    detail: { dispute: dispute.id, resolution: input.resolution ?? "admin", note },
    dedupeKey: `dispute_resolved:${dispute.id}`,
    occurredAt: now.toISOString(),
  });

  const resolved = (await deps.repo.getDispute(dispute.id)) ?? dispute;
  if (deps.mailer) {
    try {
      const sent = await deps.mailer.toFounder(save.account_id, {
        ...disputeOutcomeEmail(save, resolved, receiptUrl(deps.appUrl, save.receipt_number)),
        idempotencyKey: `dispute-outcome/${dispute.id}`,
      });
      if (sent) await deps.repo.markDisputeNotified(dispute.id, now.toISOString());
    } catch (error) {
      deps.log?.(`[disputes] outcome email for ${dispute.id} failed: ${String(error)}`);
    }
  }
  return (await deps.repo.getDispute(dispute.id)) ?? resolved;
}

// -----------------------------------------------------------------------------
// Receipt emails (the verify.ts TODO): one per verified save, sent once.
// -----------------------------------------------------------------------------

/**
 * Emails the founder a receipt for each newly verified save (cancel or
 * dunning). Claimed per save with a compare-and-set and sent with a Resend
 * idempotency key, so the webhook and the daily cron can both call it.
 */
export async function sendReceiptEmails(
  deps: LedgerDeps,
  options: { accountId?: string; sinceDays?: number; limit?: number } = {},
): Promise<{ sent: number; failed: number }> {
  const now = deps.now?.() ?? new Date();
  if (!deps.mailer) return { sent: 0, failed: 0 };
  const since = new Date(now.getTime() - (options.sinceDays ?? 7) * 86_400_000).toISOString();
  const saves = await deps.repo.savesNeedingReceipt(since, options.limit ?? 100, options.accountId);
  let sent = 0;
  let failed = 0;
  for (const save of saves) {
    const at = now.toISOString();
    if (!(await deps.repo.claimReceiptEmail(save.id, at))) continue;
    try {
      await deps.mailer.toFounder(save.account_id, {
        ...receiptEmail(save, receiptUrl(deps.appUrl, save.receipt_number)),
        idempotencyKey: `receipt/${save.id}`,
      });
      sent++;
    } catch (error) {
      await deps.repo.releaseReceiptEmail(save.id, at);
      deps.log?.(`[receipts] ${save.receipt_number} failed, will retry: ${String(error)}`);
      failed++;
    }
  }
  return { sent, failed };
}
