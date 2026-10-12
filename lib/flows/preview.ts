/**
 * Builds what the editor's live preview shows: the same SessionConfig the
 * real /api/widget/session would return, computed with the same offer rules
 * (selectOffer + toOfferView) against a sample subscription. Browser-safe.
 */
import type { FlowConfig, SessionConfig, WidgetApi } from "@/widget/types";
import { formatDate, selectOffer, toOfferView, type PriceSnapshot, type SubscriptionSnapshot } from "./offers";

/** A sample customer on a pricier plan, so downgrade offers have somewhere to go. */
export const PREVIEW_SUBSCRIPTION: SubscriptionSnapshot = {
  id: "sub_preview",
  customerId: "cus_preview",
  status: "active",
  currency: "usd",
  livemode: false,
  mrrCents: 99_900,
  items: [{ id: "si_preview", priceId: "price_preview_current", quantity: 1, monthlyCents: 99_900 }],
  hasDiscount: false,
  paused: false,
  cancelAtPeriodEnd: false,
  currentPeriodEnd: null,
};

export function buildPreviewSession(
  flow: FlowConfig,
  prices: readonly PriceSnapshot[],
  opts: { offersEnabled: boolean; now: Date },
): SessionConfig {
  const priceMap = new Map(prices.map((p) => [p.id, p]));
  const periodEnd = Math.floor(opts.now.getTime() / 1000) + 18 * 86_400;
  const subscription = { ...PREVIEW_SUBSCRIPTION, currentPeriodEnd: periodEnd };
  const offers: SessionConfig["offers"] = {};
  for (const reason of flow.reasons) {
    const offer = selectOffer(flow, reason.id, {
      subscription,
      prices: priceMap,
      offersEnabled: opts.offersEnabled,
      anchor: opts.now,
    });
    offers[reason.id] = offer ? toOfferView(offer) : null;
  }
  return {
    sessionId: "00000000-0000-4000-8000-000000000000",
    offersEnabled: opts.offersEnabled,
    cancelMode: flow.cancelMode,
    periodEndsOn: formatDate(periodEnd),
    reasons: flow.reasons.map((r) => ({ id: r.id, label: r.label || "(no label)", freeText: r.freeText === true })),
    offers,
  };
}

/** A fake WidgetApi for the preview: nothing leaves the browser. */
export function createPreviewApi(session: SessionConfig, delayMs = 350): WidgetApi {
  const wait = () => new Promise((resolve) => setTimeout(resolve, delayMs));
  return {
    async session() {
      await wait();
      return session;
    },
    async accept({ reasonId }) {
      await wait();
      const offer = session.offers[reasonId];
      if (!offer) throw new Error("No offer for this reason.");
      return { outcome: "saved", offer };
    },
    async cancel() {
      await wait();
      return { outcome: "canceled", mode: session.cancelMode, endsOn: session.cancelMode === "period_end" ? session.periodEndsOn : null };
    },
  };
}
