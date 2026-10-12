/**
 * Who gets credit when a failed invoice is finally paid.
 *
 *   update_link   the customer entered a new card on Unquit's /u/<token> page
 *                 and Unquit paid the invoice with it            -> billable
 *   unquit_retry  the customer reached the page from an Unquit email and
 *                 pressed "Try my card again", and Unquit asked Stripe to
 *                 pay the invoice                                -> billable
 *   external      anything else: Stripe Smart Retries on their own, the
 *                 customer paying Stripe's hosted invoice, the founder
 *                 marking it paid, …                             -> no fee
 *
 * Unquit marks a case `pending_attribution` (+ timestamp) immediately BEFORE
 * it calls `invoices.pay`, and clears it if the attempt fails. A payment is
 * Unquit's only if it lands while that mark is fresh.
 */
import { dunningSaveFeeCents } from "@/lib/pricing";

export type AttributedVia = "update_link" | "unquit_retry";
export type RecoveredVia = AttributedVia | "external";

/** How long after Unquit starts a payment we still credit it (covers a 3DS challenge). */
export const ATTRIBUTION_WINDOW_MS = 30 * 60 * 1000;
/** Tolerated clock difference between our servers and Stripe's paid_at. */
const CLOCK_SKEW_MS = 2 * 60 * 1000;

export type AttributionInput = {
  pendingAttribution: AttributedVia | null;
  pendingAttributionAt: string | null;
  /** First time the card-update page was opened (from an email link). */
  linkFirstOpenedAt: string | null;
};

export type Attribution = { via: RecoveredVia; billable: boolean; feeCents: number; reason: string };

export function decideAttribution(input: AttributionInput, paidAt: Date, amountPaidCents: number): Attribution {
  const external = (reason: string): Attribution => ({ via: "external", billable: false, feeCents: 0, reason });

  if (amountPaidCents <= 0) return external("nothing was collected");
  if (!input.pendingAttribution || !input.pendingAttributionAt) return external("paid without an Unquit payment attempt");

  const startedAt = Date.parse(input.pendingAttributionAt);
  if (!Number.isFinite(startedAt)) return external("invalid attempt time");
  const paid = paidAt.getTime();
  if (paid < startedAt - CLOCK_SKEW_MS) return external("paid before Unquit's attempt started");
  if (paid - startedAt > ATTRIBUTION_WINDOW_MS) return external("Unquit's attempt is too old to explain this payment");

  if (input.pendingAttribution === "unquit_retry") {
    // A retry only counts when it followed the customer opening an Unquit email link.
    const opened = input.linkFirstOpenedAt ? Date.parse(input.linkFirstOpenedAt) : NaN;
    if (!Number.isFinite(opened) || opened > startedAt + CLOCK_SKEW_MS) {
      return external("retry did not follow an email click");
    }
  }

  return {
    via: input.pendingAttribution,
    billable: true,
    feeCents: dunningSaveFeeCents(amountPaidCents),
    reason: input.pendingAttribution === "update_link" ? "paid with a card added on the update page" : "paid by Unquit's retry after an email click",
  };
}
