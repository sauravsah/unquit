/**
 * Offer rules as pure functions (no database, no Stripe), so they can be
 * unit-tested and read by a human:
 *
 *   • selectOffer      which offer a reason earns for THIS subscription
 *   • offersAllowed    the abuse guard (one accepted offer per N days)
 *   • savedMrrCents    what a save is worth, the basis of Unquit's 20% fee
 */
import { formatCents } from "@/lib/pricing";
import type { FlowConfig, OfferView } from "@/widget/types";

/** The parts of a Stripe subscription the cancel flow needs. */
export type SubscriptionSnapshot = {
  id: string;
  customerId: string;
  status: string;
  currency: string;
  livemode: boolean;
  /** Normalised monthly revenue before discounts (lib/stripe/mrr.ts). */
  mrrCents: number;
  items: { id: string; priceId: string; quantity: number; monthlyCents: number }[];
  hasDiscount: boolean;
  paused: boolean;
  cancelAtPeriodEnd: boolean;
  /** Unix seconds. */
  currentPeriodEnd: number | null;
};

/** A Stripe price a downgrade could move to. */
export type PriceSnapshot = {
  id: string;
  active: boolean;
  currency: string;
  productName: string;
  /** Per-unit amount in cents, per billing interval. Null for metered/tiered. */
  unitAmountCents: number | null;
  interval: string | null;
  intervalCount: number;
  /** Per-unit amount normalised to one month (0 if not a simple recurring price). */
  monthlyUnitCents: number;
};

/** An offer resolved against a real subscription, ready to apply in Stripe. */
export type ResolvedOffer =
  | { type: "discount"; percentOff: number; months: number }
  | { type: "pause"; months: number; resumesAtUnix: number }
  | {
      type: "downgrade";
      itemId: string;
      priceId: string;
      planName: string;
      newMrrCents: number;
      amountLabel: string;
    };

/** Only customers in good standing get offers (a discount won't fix a failing card). */
const OFFERABLE_STATUSES = new Set(["active", "trialing"]);
/** Subscriptions that can still be cancelled through the flow. */
export const CANCELLABLE_STATUSES = new Set(["active", "trialing", "past_due", "unpaid", "paused"]);

/** Same calendar day `months` later (UTC), clamped to the month's last day. */
export function addMonthsUtc(date: Date, months: number): Date {
  const y = date.getUTCFullYear();
  const m = date.getUTCMonth() + months;
  const lastDay = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return new Date(
    Date.UTC(y, m, Math.min(date.getUTCDate(), lastDay), date.getUTCHours(), date.getUTCMinutes(), date.getUTCSeconds()),
  );
}

export type SelectContext = {
  subscription: SubscriptionSnapshot;
  /** Prices referenced by downgrade offers, keyed by id (missing = not found). */
  prices: ReadonlyMap<string, PriceSnapshot>;
  /** False when the abuse guard has kicked in. */
  offersEnabled: boolean;
  /**
   * Fixed point in time the offer is computed from (the cancel session's
   * start). Keeps `resumes_at` identical across retries, so Stripe
   * idempotency keys always see the same request.
   */
  anchor: Date;
};

export function selectOffer(flow: FlowConfig, reasonId: string, ctx: SelectContext): ResolvedOffer | null {
  if (!ctx.offersEnabled) return null;
  const reason = flow.reasons.find((r) => r.id === reasonId);
  if (!reason) return null;
  const sub = ctx.subscription;
  if (!OFFERABLE_STATUSES.has(sub.status)) return null;

  const offer = reason.offer;
  switch (offer.type) {
    case "none":
      return null;

    case "discount":
      // Never replace a discount the founder already gave this customer.
      if (sub.hasDiscount) return null;
      return { type: "discount", percentOff: offer.percentOff, months: offer.months };

    case "pause": {
      if (sub.paused) return null;
      const resumesAt = addMonthsUtc(ctx.anchor, offer.months);
      return { type: "pause", months: offer.months, resumesAtUnix: Math.floor(resumesAt.getTime() / 1000) };
    }

    case "downgrade": {
      if (sub.items.length !== 1) return null; // multi-item plans: too ambiguous to swap safely
      const item = sub.items[0]!;
      if (item.priceId === offer.priceId) return null; // already on it
      const price = ctx.prices.get(offer.priceId);
      if (!price || !price.active || price.currency !== sub.currency) return null;
      if (price.unitAmountCents === null || price.monthlyUnitCents <= 0 || !price.interval) return null;
      const newMrrCents = Math.round(price.monthlyUnitCents * item.quantity);
      if (newMrrCents >= sub.mrrCents) return null; // must actually be cheaper
      const amount = formatCents(price.unitAmountCents * item.quantity, price.currency);
      const amountLabel =
        price.intervalCount > 1 ? `${amount} every ${price.intervalCount} ${price.interval}s` : `${amount}/${price.interval}`;
      return {
        type: "downgrade",
        itemId: item.id,
        priceId: price.id,
        planName: price.productName,
        newMrrCents,
        amountLabel,
      };
    }
  }
}

/**
 * Abuse guard: at most one ACCEPTED offer per subscription within
 * `cooldownDays`. After that the flow skips offers and goes to the cancel
 * confirmation. `cooldownDays = 0` turns the guard off.
 */
export function offersAllowed(lastAcceptedAt: string | null, cooldownDays: number, now: Date): boolean {
  if (cooldownDays <= 0 || !lastAcceptedAt) return true;
  const last = Date.parse(lastAcceptedAt);
  if (!Number.isFinite(last)) return true;
  return now.getTime() - last >= cooldownDays * 86_400_000;
}

/**
 * Saved MRR = the monthly revenue the founder keeps because of the save.
 * It is what Unquit's 20% fee is calculated on (lib/pricing.ts), so it is
 * deliberately conservative:
 *   discount  → MRR after the discount (founder only keeps the discounted price)
 *   pause     → full MRR (billing resumes at the normal price; nothing is
 *               earned until a real invoice is paid after the pause)
 *   downgrade → MRR of the cheaper plan
 * Integer cents, rounded down.
 */
export function savedMrrCents(offer: ResolvedOffer, subscription: Pick<SubscriptionSnapshot, "mrrCents">): number {
  const mrr = Math.max(0, Math.floor(subscription.mrrCents));
  switch (offer.type) {
    case "discount":
      return Math.floor((mrr * (100 - offer.percentOff)) / 100);
    case "pause":
      return mrr;
    case "downgrade":
      return Math.max(0, Math.floor(offer.newMrrCents));
  }
}

/** "March 3, 2027" in UTC. */
export function formatDate(unixSeconds: number): string {
  return new Intl.DateTimeFormat("en-US", { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" }).format(
    new Date(unixSeconds * 1000),
  );
}

/** What the end customer is shown for a resolved offer. */
export function toOfferView(offer: ResolvedOffer): OfferView {
  switch (offer.type) {
    case "discount":
      return { type: "discount", percentOff: offer.percentOff, months: offer.months };
    case "pause":
      return { type: "pause", months: offer.months, resumesOn: formatDate(offer.resumesAtUnix) };
    case "downgrade":
      return { type: "downgrade", planName: offer.planName, amountLabel: offer.amountLabel };
  }
}

/** Snapshot of the accepted offer for cancel_sessions.offer_shown / saves.offer. */
export function offerRecord(offer: ResolvedOffer): Record<string, unknown> {
  switch (offer.type) {
    case "discount":
      return { type: "discount", percent_off: offer.percentOff, months: offer.months };
    case "pause":
      return { type: "pause", months: offer.months, resumes_at: new Date(offer.resumesAtUnix * 1000).toISOString() };
    case "downgrade":
      return { type: "downgrade", price_id: offer.priceId, plan_name: offer.planName, new_mrr_cents: offer.newMrrCents };
  }
}
