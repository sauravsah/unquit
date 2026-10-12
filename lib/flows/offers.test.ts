import { describe, expect, it } from "vitest";
import type { FlowConfig } from "@/widget/types";
import {
  addMonthsUtc,
  offersAllowed,
  savedMrrCents,
  selectOffer,
  toOfferView,
  type PriceSnapshot,
  type ResolvedOffer,
  type SelectContext,
  type SubscriptionSnapshot,
} from "./offers";
import { templateFlow } from "./templates";

const sub = (over: Partial<SubscriptionSnapshot> = {}): SubscriptionSnapshot => ({
  id: "sub_1",
  customerId: "cus_1",
  status: "active",
  currency: "usd",
  livemode: false,
  mrrCents: 4_900,
  items: [{ id: "si_1", priceId: "price_pro", quantity: 1, monthlyCents: 4_900 }],
  hasDiscount: false,
  paused: false,
  cancelAtPeriodEnd: false,
  currentPeriodEnd: null,
  ...over,
});

const basic: PriceSnapshot = {
  id: "price_basic",
  active: true,
  currency: "usd",
  productName: "Basic",
  unitAmountCents: 1_900,
  interval: "month",
  intervalCount: 1,
  monthlyUnitCents: 1_900,
};

const ANCHOR = new Date("2026-01-31T12:00:00Z");

const flow: FlowConfig = {
  template: "custom",
  cancelMode: "period_end",
  offerCooldownDays: 90,
  reasons: [
    { id: "too_expensive", label: "Too expensive", offer: { type: "discount", percentOff: 30, months: 3 } },
    { id: "not_using", label: "Not using it", offer: { type: "pause", months: 2 } },
    { id: "cheaper", label: "Want something cheaper", offer: { type: "downgrade", priceId: "price_basic" } },
    { id: "other", label: "Other", freeText: true, offer: { type: "none" } },
  ],
};

const ctx = (over: Partial<SelectContext> = {}): SelectContext => ({
  subscription: sub(),
  prices: new Map([[basic.id, basic]]),
  offersEnabled: true,
  anchor: ANCHOR,
  ...over,
});

describe("selectOffer: the offer matches the reason", () => {
  it("gives each reason its configured offer", () => {
    expect(selectOffer(flow, "too_expensive", ctx())).toEqual({ type: "discount", percentOff: 30, months: 3 });
    expect(selectOffer(flow, "not_using", ctx())).toMatchObject({ type: "pause", months: 2 });
    expect(selectOffer(flow, "cheaper", ctx())).toMatchObject({
      type: "downgrade",
      itemId: "si_1",
      priceId: "price_basic",
      planName: "Basic",
      newMrrCents: 1_900,
      amountLabel: "$19.00/month",
    });
  });

  it("returns no offer for 'none' and for unknown reasons", () => {
    expect(selectOffer(flow, "other", ctx())).toBeNull();
    expect(selectOffer(flow, "made_up", ctx())).toBeNull();
  });

  it("follows the templates", () => {
    const pauseFirst = templateFlow("pause_first");
    const discountFirst = templateFlow("discount_first");
    expect(selectOffer(pauseFirst, "too_expensive", ctx())?.type).toBe("pause");
    expect(selectOffer(discountFirst, "not_using", ctx())?.type).toBe("discount");
    const balanced = templateFlow("balanced");
    expect(selectOffer(balanced, "too_expensive", ctx())?.type).toBe("discount");
    expect(selectOffer(balanced, "not_using", ctx())?.type).toBe("pause");
  });

  it("offers nothing when the abuse guard has switched offers off", () => {
    for (const r of flow.reasons) expect(selectOffer(flow, r.id, ctx({ offersEnabled: false }))).toBeNull();
  });

  it("offers nothing to subscriptions that aren't in good standing", () => {
    expect(selectOffer(flow, "too_expensive", ctx({ subscription: sub({ status: "past_due" }) }))).toBeNull();
    expect(selectOffer(flow, "too_expensive", ctx({ subscription: sub({ status: "canceled" }) }))).toBeNull();
    expect(selectOffer(flow, "too_expensive", ctx({ subscription: sub({ status: "trialing" }) }))).not.toBeNull();
  });

  it("never replaces a discount the customer already has", () => {
    expect(selectOffer(flow, "too_expensive", ctx({ subscription: sub({ hasDiscount: true }) }))).toBeNull();
  });

  it("doesn't pause an already-paused subscription", () => {
    expect(selectOffer(flow, "not_using", ctx({ subscription: sub({ paused: true }) }))).toBeNull();
  });

  it("pause resumes the same calendar day N months after the session started (clamped)", () => {
    const offer = selectOffer(flow, "not_using", ctx()) as Extract<ResolvedOffer, { type: "pause" }>;
    // Jan 31 + 2 months = Mar 31
    expect(new Date(offer.resumesAtUnix * 1000).toISOString()).toBe("2026-03-31T12:00:00.000Z");
    expect(addMonthsUtc(ANCHOR, 1).toISOString()).toBe("2026-02-28T12:00:00.000Z");
    expect(toOfferView(offer)).toEqual({ type: "pause", months: 2, resumesOn: "March 31, 2026" });
  });

  it("only downgrades to an active, cheaper price in the same currency on a single-item plan", () => {
    const tryWith = (over: Partial<SelectContext>) => selectOffer(flow, "cheaper", ctx(over));
    expect(tryWith({ prices: new Map() })).toBeNull(); // price not found
    expect(tryWith({ prices: new Map([[basic.id, { ...basic, active: false }]]) })).toBeNull();
    expect(tryWith({ prices: new Map([[basic.id, { ...basic, currency: "eur" }]]) })).toBeNull();
    expect(tryWith({ prices: new Map([[basic.id, { ...basic, monthlyUnitCents: 9_900, unitAmountCents: 9_900 }]]) })).toBeNull();
    expect(tryWith({ subscription: sub({ items: [{ id: "si_1", priceId: "price_basic", quantity: 1, monthlyCents: 1_900 }] }) })).toBeNull();
    expect(
      tryWith({
        subscription: sub({
          items: [
            { id: "si_1", priceId: "price_pro", quantity: 1, monthlyCents: 2_450 },
            { id: "si_2", priceId: "price_addon", quantity: 1, monthlyCents: 2_450 },
          ],
        }),
      }),
    ).toBeNull();
  });

  it("scales a downgrade by seat quantity", () => {
    const seats = sub({ mrrCents: 14_700, items: [{ id: "si_1", priceId: "price_pro", quantity: 3, monthlyCents: 14_700 }] });
    expect(selectOffer(flow, "cheaper", ctx({ subscription: seats }))).toMatchObject({
      newMrrCents: 5_700,
      amountLabel: "$57.00/month",
    });
  });
});

describe("offersAllowed: one accepted offer per subscription per cooldown", () => {
  const now = new Date("2026-06-01T00:00:00Z");
  const daysAgo = (d: number) => new Date(now.getTime() - d * 86_400_000).toISOString();

  it("allows offers when the subscription never accepted one", () => {
    expect(offersAllowed(null, 90, now)).toBe(true);
  });

  it("blocks offers inside the window", () => {
    expect(offersAllowed(daysAgo(1), 90, now)).toBe(false);
    expect(offersAllowed(daysAgo(89.9), 90, now)).toBe(false);
  });

  it("allows offers again once the window has passed", () => {
    expect(offersAllowed(daysAgo(90), 90, now)).toBe(true);
    expect(offersAllowed(daysAgo(200), 90, now)).toBe(true);
  });

  it("respects a founder-configured window, and 0 turns the guard off", () => {
    expect(offersAllowed(daysAgo(20), 14, now)).toBe(true);
    expect(offersAllowed(daysAgo(20), 30, now)).toBe(false);
    expect(offersAllowed(daysAgo(0), 0, now)).toBe(true);
  });
});

describe("savedMrrCents: what a save is worth (the basis of the 20% fee)", () => {
  it("discount: the MRR the founder still collects after the discount, rounded down", () => {
    expect(savedMrrCents({ type: "discount", percentOff: 30, months: 3 }, { mrrCents: 4_900 })).toBe(3_430);
    expect(savedMrrCents({ type: "discount", percentOff: 25, months: 1 }, { mrrCents: 999 })).toBe(749); // 749.25 -> 749
    expect(savedMrrCents({ type: "discount", percentOff: 90, months: 1 }, { mrrCents: 10_000 })).toBe(1_000);
  });

  it("pause: the full MRR (billing resumes at the normal price)", () => {
    expect(savedMrrCents({ type: "pause", months: 2, resumesAtUnix: 0 }, { mrrCents: 4_900 })).toBe(4_900);
  });

  it("downgrade: the MRR of the cheaper plan", () => {
    const offer: ResolvedOffer = {
      type: "downgrade",
      itemId: "si_1",
      priceId: "price_basic",
      planName: "Basic",
      newMrrCents: 1_900,
      amountLabel: "$19.00/month",
    };
    expect(savedMrrCents(offer, { mrrCents: 4_900 })).toBe(1_900);
  });

  it("is always a non-negative integer", () => {
    expect(savedMrrCents({ type: "pause", months: 1, resumesAtUnix: 0 }, { mrrCents: -5 })).toBe(0);
    expect(Number.isInteger(savedMrrCents({ type: "discount", percentOff: 33, months: 1 }, { mrrCents: 1_001 }))).toBe(true);
  });
});
