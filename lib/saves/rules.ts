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
  status: "pending" | "verified" | "disputed" | "clawed_back";
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

/** First day of the invoice's month (UTC), as YYYY-MM-DD, for fee lines. */
export function billingMonthOf(unixSeconds: number): string {
  const d = new Date(unixSeconds * 1000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-01`;
}
