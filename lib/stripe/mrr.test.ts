import { describe, expect, it } from "vitest";
import { itemMonthlyCents, subscriptionMrrCents } from "./mrr";

const price = (unit_amount: number, interval: string, interval_count = 1, usage_type = "licensed") => ({
  unit_amount,
  recurring: { interval, interval_count, usage_type },
});

describe("MRR normalisation", () => {
  it("monthly price × quantity", () => {
    expect(itemMonthlyCents({ quantity: 3, price: price(1_000, "month") })).toBe(3_000);
  });

  it("yearly price ÷ 12", () => {
    expect(itemMonthlyCents({ quantity: 1, price: price(12_000, "year") })).toBe(1_000);
  });

  it("quarterly (every 3 months) ÷ 3", () => {
    expect(itemMonthlyCents({ quantity: 1, price: price(3_000, "month", 3) })).toBe(1_000);
  });

  it("weekly × 52 / 12", () => {
    expect(itemMonthlyCents({ quantity: 1, price: price(1_200, "week") })).toBeCloseTo(5_200);
  });

  it("ignores metered and one-off prices", () => {
    expect(itemMonthlyCents({ quantity: 1, price: price(1_000, "month", 1, "metered") })).toBe(0);
    expect(itemMonthlyCents({ quantity: 1, price: { unit_amount: 1_000, recurring: null } })).toBe(0);
  });

  it("sums all items on a subscription", () => {
    const sub = {
      items: { data: [{ quantity: 1, price: price(2_900, "month") }, { quantity: 2, price: price(12_000, "year") }] },
    };
    // 2900 + 2 * 1000
    expect(subscriptionMrrCents(sub as never)).toBe(4_900);
  });
});
