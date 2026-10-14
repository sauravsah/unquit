/**
 * The cancel-save lifecycle:
 *
 *   pending ──first qualifying paid invoice──▶ verified (fee line month 1)
 *      │                                         │
 *      │                                         ├─ month 2, month 3 on the next paid invoices
 *      │                                         │  (then the save is free forever)
 *      │                                         └─ subscription cancelled ─▶ ended (no more months;
 *      │                                                                       earned fees stand)
 *      ├─ no qualifying paid invoice in 45 days (after a pause ends) ─▶ lost (expired)
 *      ├─ a later cancel session on the same subscription ─▶ lost (superseded / customer_canceled)
 *      └─ subscription cancelled ─▶ lost (customer_canceled)
 *
 * Plus: abandoned cancel sessions (still "started" after 24 hours).
 *
 * All writes are compare-and-set or go through a unique constraint, so two
 * webhook deliveries (or a webhook racing the cron) record everything once.
 */
import { cancelSaveMonthlyFeeCents, CANCEL_SAVE_BILLABLE_MONTHS } from "@/lib/pricing";
import { netCents } from "@/lib/ledger/fees";
import { applyOverlapPricing } from "@/lib/ledger/overlap";
import type { LedgerRepo, SaveRow } from "@/lib/ledger/types";
import {
  billingMonthOf,
  decideCancelSaveVerification,
  decideNextFeeMonth,
  DEFAULT_VERIFY_WINDOW_DAYS,
  pendingDeadline,
  type PaidInvoice,
} from "./rules";

export type PaidInvoiceEvent = PaidInvoice & {
  customerEmail?: string | null;
  /** When Stripe says it was paid (falls back to now). */
  paidAt?: Date;
};

export type VerifyResult = {
  verified: string[];
  /** Month 2/3 lines added to already-verified saves. */
  monthsAdded: { saveId: string; monthIndex: number }[];
  /** Recovery lines on this invoice reduced to 5% because it also earned a cancel-save fee. */
  overlapReduced?: string[];
  skipped: { id: string; reason: string }[];
};

/** Recomputes saves.fee_cents from its lines (net of clawbacks, before the cap). */
export async function refreshSaveFee(repo: LedgerRepo, saveId: string): Promise<number> {
  const lines = await repo.linesForSave(saveId);
  const total = lines.reduce((acc, l) => acc + netCents(l), 0);
  await repo.setSaveFee(saveId, total);
  return total;
}

/**
 * Called from the `invoice.paid` webhook for the founder's account.
 *   1. Flips matching PENDING cancel saves to VERIFIED and writes fee line 1.
 *   2. Adds fee lines 2 and 3 to verified saves on the same subscription.
 *   3. Overlap pricing (lib/ledger/overlap.ts): a recovery fee on the same
 *      invoice drops to 5%. The webhook records the recovery first, so both
 *      lines exist by now; the step is idempotent if it runs again.
 */
export async function processPaidInvoice(
  repo: LedgerRepo,
  accountId: string,
  invoice: PaidInvoiceEvent,
  now: Date = new Date(),
): Promise<VerifyResult> {
  const result: VerifyResult = { verified: [], monthsAdded: [], skipped: [] };
  if (!invoice.subscriptionId) return result;
  const at = (invoice.paidAt ?? now).toISOString();
  const billingMonth = billingMonthOf(invoice.createdUnix);

  // --- 1. pending -> verified ------------------------------------------------
  const pending = await repo.savesForSubscription(accountId, invoice.subscriptionId, ["pending"]);
  for (const save of pending.filter((s) => s.type === "cancel")) {
    const decision = decideCancelSaveVerification(save, invoice);
    if (!decision.verify) {
      result.skipped.push({ id: save.id, reason: decision.reason });
      continue;
    }
    const won = await repo.verifySave(save.id, { verifiedAt: at, invoiceId: invoice.id, customerEmail: invoice.customerEmail ?? null });
    if (!won) continue; // a concurrent delivery verified it first

    const feeCents = cancelSaveMonthlyFeeCents(Number(save.saved_mrr_cents), 1);
    await repo.insertFeeLine({
      save_id: save.id,
      account_id: accountId,
      month_index: 1,
      billing_month: billingMonth,
      stripe_invoice_id: invoice.id,
      amount_cents: feeCents,
      invoice_amount_paid_cents: invoice.amountPaidCents,
      held_founder_dispute_id: null,
    });
    await refreshSaveFee(repo, save.id);
    await repo.addEvent({
      accountId,
      saveId: save.id,
      kind: "invoice_paid",
      detail: { invoice: invoice.id, amount_paid_cents: invoice.amountPaidCents },
      dedupeKey: `invoice_paid:${save.id}:${invoice.id}`,
      occurredAt: at,
    });
    await repo.addEvent({
      accountId,
      saveId: save.id,
      kind: "verified",
      detail: { invoice: invoice.id, fee_cents: feeCents, month_index: 1 },
      dedupeKey: `verified:${save.id}`,
      occurredAt: at,
    });
    result.verified.push(save.id);
  }

  // --- 2. months 2 and 3 -------------------------------------------------------
  const active = await repo.savesForSubscription(accountId, invoice.subscriptionId, ["verified", "disputed"]);
  for (const save of active) {
    if (save.type !== "cancel" || result.verified.includes(save.id)) continue;
    const lines = await repo.linesForSave(save.id);
    const decision = decideNextFeeMonth(save, lines, invoice, CANCEL_SAVE_BILLABLE_MONTHS);
    if (!decision.add) {
      result.skipped.push({ id: save.id, reason: decision.reason });
      continue;
    }
    // A save the founder is disputing keeps earning, but the new line is held too.
    const openDispute = save.status === "disputed" ? await repo.openDisputeForSave(save.id) : null;
    const feeCents = cancelSaveMonthlyFeeCents(Number(save.saved_mrr_cents), decision.monthIndex);
    const line = await repo.insertFeeLine({
      save_id: save.id,
      account_id: accountId,
      month_index: decision.monthIndex,
      billing_month: billingMonth,
      stripe_invoice_id: invoice.id,
      amount_cents: feeCents,
      invoice_amount_paid_cents: invoice.amountPaidCents,
      held_founder_dispute_id: openDispute?.id ?? null,
    });
    if (!line) continue; // a concurrent delivery added it
    await refreshSaveFee(repo, save.id);
    await repo.addEvent({
      accountId,
      saveId: save.id,
      kind: "fee_line",
      detail: { invoice: invoice.id, fee_cents: feeCents, month_index: decision.monthIndex, amount_paid_cents: invoice.amountPaidCents },
      dedupeKey: `fee_line:${save.id}:${decision.monthIndex}`,
      occurredAt: at,
    });
    result.monthsAdded.push({ saveId: save.id, monthIndex: decision.monthIndex });
  }

  // --- 3. overlap: this invoice also earned a recovery fee -> that fee is 5% ----
  const overlap = await applyOverlapPricing(repo, accountId, invoice.id, invoice.paidAt ?? now);
  if (overlap.reduced.length > 0) result.overlapReduced = overlap.reduced.map((r) => r.saveId);

  return result;
}

/**
 * The customer's subscription was cancelled (customer.subscription.deleted /
 * status canceled, or "No thanks, cancel" in a later cancel session).
 * Pending saves are lost; verified ones stop earning (their fees stand).
 */
export async function endSavesForSubscription(
  repo: LedgerRepo,
  accountId: string,
  subscriptionId: string,
  at: Date,
  options: { keepSessionId?: string | null } = {},
): Promise<{ lost: string[]; ended: string[] }> {
  const out = { lost: [] as string[], ended: [] as string[] };
  const saves = await repo.savesForSubscription(accountId, subscriptionId, ["pending", "verified", "disputed"]);
  for (const save of saves) {
    if (save.type !== "cancel" || (options.keepSessionId && save.cancel_session_id === options.keepSessionId)) continue;
    if (save.status === "pending") {
      if (await repo.markLost(save.id, "customer_canceled", at.toISOString())) {
        await lostEvent(repo, save, "customer_canceled", at);
        out.lost.push(save.id);
      }
    } else if (!save.ended_at) {
      if (await repo.markEnded(save.id, "customer_canceled", at.toISOString())) {
        await repo.addEvent({
          accountId,
          saveId: save.id,
          kind: "ended",
          detail: { reason: "customer_canceled" },
          dedupeKey: `ended:${save.id}`,
          occurredAt: at.toISOString(),
        });
        out.ended.push(save.id);
      }
    }
  }
  return out;
}

/**
 * A new offer was accepted on a subscription: any OLDER pending save on it
 * can't be proven any more (the new offer changed the subscription), so it is
 * lost as superseded. The new save is the one that counts.
 */
export async function supersedePendingSaves(
  repo: LedgerRepo,
  accountId: string,
  subscriptionId: string,
  keepSessionId: string,
  at: Date,
): Promise<string[]> {
  const lost: string[] = [];
  const pending = await repo.savesForSubscription(accountId, subscriptionId, ["pending"]);
  for (const save of pending) {
    if (save.type !== "cancel" || save.cancel_session_id === keepSessionId) continue;
    if (await repo.markLost(save.id, "superseded", at.toISOString())) {
      await lostEvent(repo, save, "superseded", at, { by_session: keepSessionId });
      lost.push(save.id);
    }
  }
  return lost;
}

/**
 * Daily: pending saves with no qualifying paid invoice within the window
 * (default 45 days, measured from the end of a pause) become lost.
 */
export async function expirePendingSaves(
  repo: LedgerRepo,
  now: Date,
  windowDays = DEFAULT_VERIFY_WINDOW_DAYS,
  limit = 500,
): Promise<string[]> {
  const cutoff = new Date(now.getTime() - windowDays * 86_400_000).toISOString();
  const candidates = await repo.pendingSavesCreatedBefore(cutoff, limit);
  const expired: string[] = [];
  for (const save of candidates) {
    if (save.type !== "cancel") continue;
    if (pendingDeadline(save, windowDays).getTime() > now.getTime()) continue; // still inside a pause
    if (await repo.markLost(save.id, "expired", now.toISOString())) {
      await lostEvent(repo, save, "expired", now, { window_days: windowDays });
      expired.push(save.id);
    }
  }
  return expired;
}

/** Daily: cancel sessions still "started" after 24 hours were closed without an answer. */
export async function abandonStaleSessions(repo: LedgerRepo, now: Date, hours = 24): Promise<number> {
  return repo.abandonSessionsStartedBefore(new Date(now.getTime() - hours * 3_600_000).toISOString());
}

async function lostEvent(repo: LedgerRepo, save: SaveRow, reason: string, at: Date, detail: Record<string, unknown> = {}) {
  await repo.addEvent({
    accountId: save.account_id,
    saveId: save.id,
    kind: "lost",
    detail: { reason, ...detail },
    dedupeKey: `lost:${save.id}`,
    occurredAt: at.toISOString(),
  });
}

/** Env-configurable windows (VERIFY_WINDOW_DAYS, default 45). */
export function verifyWindowDays(raw: string | undefined = process.env.VERIFY_WINDOW_DAYS): number {
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 && n <= 365 ? n : DEFAULT_VERIFY_WINDOW_DAYS;
}
