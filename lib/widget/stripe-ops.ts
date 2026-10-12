import "server-only";
import type Stripe from "stripe";
import type { PriceSnapshot, ResolvedOffer, SubscriptionSnapshot } from "@/lib/flows/offers";
import { idOf } from "@/lib/stripe/ids";
import { itemMonthlyCents, subscriptionMrrCents, subscriptionPeriodEnd } from "@/lib/stripe/mrr";
import type { StripeOps } from "./service";

/**
 * The real Stripe side of the cancel flow. Every call runs ON THE FOUNDER'S
 * connected account (`stripeAccount` header), using Unquit's platform key,
 * and every write carries an idempotency key derived from the cancel session.
 */

function isMissing(error: unknown): boolean {
  return (error as { code?: string } | null)?.code === "resource_missing";
}

export function toSubscriptionSnapshot(sub: Stripe.Subscription): SubscriptionSnapshot {
  const legacyDiscount = (sub as unknown as { discount?: unknown }).discount;
  return {
    id: sub.id,
    customerId: idOf(sub.customer) ?? "",
    status: sub.status,
    currency: sub.currency ?? "usd",
    livemode: sub.livemode,
    mrrCents: subscriptionMrrCents(sub),
    items: (sub.items?.data ?? []).map((item) => ({
      id: item.id,
      priceId: item.price?.id ?? "",
      quantity: item.quantity ?? 1,
      monthlyCents: Math.round(itemMonthlyCents(item)),
    })),
    hasDiscount: (sub.discounts?.length ?? 0) > 0 || !!legacyDiscount,
    paused: !!sub.pause_collection || sub.status === "paused",
    cancelAtPeriodEnd: sub.cancel_at_period_end ?? false,
    currentPeriodEnd: subscriptionPeriodEnd(sub),
  };
}

export function toPriceSnapshot(price: Stripe.Price): PriceSnapshot {
  const product = price.product;
  const productName =
    typeof product === "object" && product && "name" in product && typeof product.name === "string" ? product.name : "a smaller plan";
  return {
    id: price.id,
    active: price.active,
    currency: price.currency,
    productName,
    unitAmountCents: price.unit_amount ?? null,
    interval: price.recurring?.interval ?? null,
    intervalCount: price.recurring?.interval_count ?? 1,
    monthlyUnitCents: itemMonthlyCents({ quantity: 1, price }),
  };
}

export function createStripeOps(stripe: Stripe, stripeAccount: string): StripeOps {
  const on = { stripeAccount };

  async function ensureCoupon(percentOff: number, months: number, idempotencyKey: string): Promise<string> {
    // One reusable coupon per offer shape, e.g. unquit_30off_3m, instead of one per customer.
    const id = `unquit_${percentOff}off_${months}m`;
    try {
      await stripe.coupons.retrieve(id, {}, on);
      return id;
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    try {
      await stripe.coupons.create(
        {
          id,
          percent_off: percentOff,
          duration: "repeating",
          duration_in_months: months,
          name: `${percentOff}% off for ${months} month${months === 1 ? "" : "s"} (unquit)`,
          metadata: { created_by: "unquit" },
        },
        { ...on, idempotencyKey: `${idempotencyKey}_coupon` },
      );
    } catch (error) {
      // Another session created it a moment ago: fine, it's the same coupon.
      if ((error as { code?: string }).code !== "resource_already_exists") throw error;
    }
    return id;
  }

  return {
    async getSubscription(subscriptionId) {
      try {
        return toSubscriptionSnapshot(await stripe.subscriptions.retrieve(subscriptionId, {}, on));
      } catch (error) {
        if (isMissing(error)) return null;
        throw error;
      }
    },

    async getPrice(priceId) {
      try {
        return toPriceSnapshot(await stripe.prices.retrieve(priceId, { expand: ["product"] }, on));
      } catch (error) {
        if (isMissing(error)) return null;
        throw error;
      }
    },

    async applyOffer(subscription, offer, idempotencyKey, sessionId) {
      const common: Stripe.SubscriptionUpdateParams = {
        metadata: { unquit_cancel_session: sessionId },
        // A customer who had already scheduled a cancel is now staying.
        ...(subscription.cancelAtPeriodEnd ? { cancel_at_period_end: false } : {}),
      };
      let params: Stripe.SubscriptionUpdateParams;
      switch (offer.type) {
        case "discount": {
          const coupon = await ensureCoupon(offer.percentOff, offer.months, idempotencyKey);
          params = { ...common, discounts: [{ coupon }] };
          break;
        }
        case "pause":
          // 'void': invoices during the pause are voided, so nothing is charged.
          params = { ...common, pause_collection: { behavior: "void", resumes_at: offer.resumesAtUnix } };
          break;
        case "downgrade":
          // No proration: the cheaper price applies from the next renewal invoice.
          params = { ...common, items: [{ id: offer.itemId, price: offer.priceId }], proration_behavior: "none" };
          break;
      }
      await stripe.subscriptions.update(subscription.id, params, { ...on, idempotencyKey });
    },

    async cancel(subscription, mode, details, idempotencyKey) {
      const cancellation_details = { feedback: details.feedback, comment: details.comment };
      if (mode === "immediately") {
        await stripe.subscriptions.cancel(subscription.id, { cancellation_details }, { ...on, idempotencyKey });
      } else {
        await stripe.subscriptions.update(
          subscription.id,
          { cancel_at_period_end: true, cancellation_details },
          { ...on, idempotencyKey },
        );
      }
    },
  };
}
