/**
 * The save rules, as pure functions (no database, no Stripe) so they can be
 * unit-tested and read by a human.
 *
 *   A CANCEL save counts only when the customer accepted an in-flow offer
 *   AND their next invoice was paid.
 *
 *   A DUNNING save is a failed invoice paid through Unquit's retry or link.
 */

export type PendingCancelSave = {
  id: string;
  type: "cancel" | "dunning";
  status: "pending" | "verified" | "disputed" | "clawed_back" | "lost";
  stripe_subscription_id: string | null;
  /** When the save row was created = when the customer accepted the offer. */
  created_at: string;
};

export type PaidInvoice = {
  id: string;
  subscriptionId: string | null;
  amountPaidCents: number;
  /** Stripe `invoice.created`, unix seconds. */
  createdUnix: number;
  /** Stripe `invoice.billing_reason`. */
  billingReason: string | null;
};

export type VerificationDecision =
  | { verify: true }
  | { verify: false; reason: string };

/** Invoices that represent the customer paying for continued service. */
const QUALIFYING_BILLING_REASONS = new Set(["subscription_cycle", "subscription_update", "subscription"]);

export function decideCancelSaveVerification(save: PendingCancelSave, invoice: PaidInvoice): VerificationDecision {
  if (save.type !== "cancel") return { verify: false, reason: "not a cancel save" };
  if (save.status !== "pending") return { verify: false, reason: `save is already ${save.status}` };
  if (!save.stripe_subscription_id || save.stripe_subscription_id !== invoice.subscriptionId) {
    return { verify: false, reason: "invoice is for a different subscription" };
  }

  // "Next invoice" = an invoice created after the offer was accepted.
  const acceptedAtMs = Date.parse(save.created_at);
  if (!Number.isFinite(acceptedAtMs)) return { verify: false, reason: "save has no valid acceptance time" };
  if (invoice.createdUnix * 1000 <= acceptedAtMs) {
    return { verify: false, reason: "invoice predates the accepted offer" };
  }

  // A $0 invoice (e.g. during a free-month or pause offer) does not prove the
  // customer is paying again. The save stays pending until a real payment.
  if (invoice.amountPaidCents <= 0) return { verify: false, reason: "invoice paid $0" };

  if (!invoice.billingReason || !QUALIFYING_BILLING_REASONS.has(invoice.billingReason)) {
    return { verify: false, reason: `billing reason ${invoice.billingReason ?? "unknown"} does not qualify` };
  }

  return { verify: true };
}

// -----------------------------------------------------------------------------
// Months 2 and 3 of a verified cancel save
// -----------------------------------------------------------------------------

export type VerifiedCancelSave = PendingCancelSave & {
  saved_mrr_cents: number;
  ended_at: string | null;
};

export type ExistingFeeLine = { month_index: number; stripe_invoice_id: string | null };

export type NextMonthDecision =
  | { add: true; monthIndex: number }
  | { add: false; reason: string };

/**
 * Does this paid invoice earn the next month's 20% on an already-verified
 * cancel save? Months 1–3 only (then the save is free forever), one line per
 * invoice, same subscription, a real payment, and never after the
 * subscription ended.
 */
export function decideNextFeeMonth(
  save: VerifiedCancelSave,
  lines: readonly ExistingFeeLine[],
  invoice: PaidInvoice,
  billableMonths = 3,
): NextMonthDecision {
  if (save.type !== "cancel") return { add: false, reason: "not a cancel save" };
  if (save.status !== "verified" && save.status !== "disputed") return { add: false, reason: `save is ${save.status}` };
  if (save.ended_at) return { add: false, reason: "subscription ended" };
  if (!save.stripe_subscription_id || save.stripe_subscription_id !== invoice.subscriptionId) {
    return { add: false, reason: "invoice is for a different subscription" };
  }
  if (lines.some((l) => l.stripe_invoice_id === invoice.id)) return { add: false, reason: "invoice already counted" };
  if (lines.length >= billableMonths) return { add: false, reason: "all billable months recorded; the save is free from now on" };
  const acceptedAtMs = Date.parse(save.created_at);
  if (!Number.isFinite(acceptedAtMs) || invoice.createdUnix * 1000 <= acceptedAtMs) {
    return { add: false, reason: "invoice predates the accepted offer" };
  }
  if (invoice.amountPaidCents <= 0) return { add: false, reason: "invoice paid $0" };
  if (!invoice.billingReason || !QUALIFYING_BILLING_REASONS.has(invoice.billingReason)) {
    return { add: false, reason: `billing reason ${invoice.billingReason ?? "unknown"} does not qualify` };
  }
  const monthIndex = Math.max(0, ...lines.map((l) => l.month_index)) + 1;
  if (monthIndex > billableMonths) return { add: false, reason: "all billable months recorded; the save is free from now on" };
  return { add: true, monthIndex };
}

// -----------------------------------------------------------------------------
// Pending-save expiry
// -----------------------------------------------------------------------------

export const DEFAULT_VERIFY_WINDOW_DAYS = 45;
const DAY_MS = 86_400_000;

/**
 * When a pending cancel save gives up waiting for its first paid invoice:
 * `windowDays` after the offer was accepted, or after a pause ends (no
 * invoice can be paid while the subscription is paused).
 */
export function pendingDeadline(
  save: { created_at: string; offer: Record<string, unknown> | null },
  windowDays = DEFAULT_VERIFY_WINDOW_DAYS,
): Date {
  let start = Date.parse(save.created_at);
  const offer = save.offer;
  if (offer && offer.type === "pause" && typeof offer.resumes_at === "string") {
    const resumes = Date.parse(offer.resumes_at);
    if (Number.isFinite(resumes) && resumes > start) start = resumes;
  }
  return new Date(start + windowDays * DAY_MS);
}

/** First day of the invoice's month (UTC), as YYYY-MM-DD, for fee lines. */
export function billingMonthOf(unixSeconds: number): string {
  const d = new Date(unixSeconds * 1000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-01`;
}
