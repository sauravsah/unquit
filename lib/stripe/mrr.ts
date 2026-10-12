import type Stripe from "stripe";

/**
 * Monthly recurring revenue of one Stripe subscription, in cents.
 *
 * Normalises every item to a monthly amount:
 *   yearly price ÷ 12, weekly × 52/12, daily × 365/12, every-N-months ÷ N.
 *
 * Deliberately simple for week 1: ignores discounts, tax and metered/tiered
 * prices (those items count as 0). Good enough for "MRR at risk".
 */
export function subscriptionMrrCents(subscription: Pick<Stripe.Subscription, "items">): number {
  let total = 0;
  for (const item of subscription.items?.data ?? []) {
    total += itemMonthlyCents(item);
  }
  return Math.round(total);
}

type ItemLike = {
  quantity?: number | null;
  price?: {
    unit_amount?: number | null;
    /** A string in raw JSON; a Decimal object in newer SDK typings. Both stringify. */
    unit_amount_decimal?: { toString(): string } | string | null;
    recurring?: { interval: string; interval_count: number; usage_type?: string } | null;
  } | null;
};

export function itemMonthlyCents(item: ItemLike): number {
  const price = item.price;
  if (!price?.recurring) return 0;
  if (price.recurring.usage_type === "metered") return 0;

  const unit =
    price.unit_amount ??
    (price.unit_amount_decimal != null ? Number.parseFloat(String(price.unit_amount_decimal)) : 0);
  if (!Number.isFinite(unit) || unit <= 0) return 0;

  const quantity = item.quantity ?? 1;
  const count = Math.max(1, price.recurring.interval_count || 1);
  const perInterval = unit * quantity;

  switch (price.recurring.interval) {
    case "month":
      return perInterval / count;
    case "year":
      return perInterval / (12 * count);
    case "week":
      return (perInterval * 52) / (12 * count);
    case "day":
      return (perInterval * 365) / (12 * count);
    default:
      return 0;
  }
}

/** Latest `current_period_end` across items (moved from subscription to items in newer API versions). */
export function subscriptionPeriodEnd(subscription: Stripe.Subscription): number | null {
  const legacy = (subscription as unknown as { current_period_end?: number | null }).current_period_end;
  if (typeof legacy === "number") return legacy;
  let max: number | null = null;
  for (const item of subscription.items?.data ?? []) {
    if (typeof item.current_period_end === "number" && (max === null || item.current_period_end > max)) {
      max = item.current_period_end;
    }
  }
  return max;
}
