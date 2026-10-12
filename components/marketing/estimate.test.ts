import { describe, expect, it } from "vitest";
import { MONTHLY_FEE_CAP_CENTS } from "@/lib/pricing";
import { estimateMonthlyFee } from "./estimate";

describe("estimateMonthlyFee", () => {
  it("charges 20% × 3 months of saved MRR plus 10% of recovered", () => {
    // 10 cancels × $50 = $500 at risk, 25% saved = $125 saved MRR → $25 × 3 = $75.
    // 10 failed × $50 = $500, 50% recovered = $250 → $25.
    const e = estimateMonthlyFee({ mrrDollars: 10_000, cancelsPerMonth: 10, failedPerMonth: 10, arpuDollars: 50 });
    expect(e.savedMrrCents).toBe(12_500);
    expect(e.cancelFeeCents).toBe(7_500);
    expect(e.recoveredCents).toBe(25_000);
    expect(e.dunningFeeCents).toBe(2_500);
    expect(e.feeCents).toBe(10_000);
    expect(e.capReached).toBe(false);
    expect(e.netCents).toBe(12_500 + 25_000 - 10_000);
  });

  it("never charges more than the $299 cap", () => {
    const e = estimateMonthlyFee({ mrrDollars: 200_000, cancelsPerMonth: 400, failedPerMonth: 400, arpuDollars: 100 });
    expect(e.feeCents).toBe(MONTHLY_FEE_CAP_CENTS);
    expect(e.capReached).toBe(true);
  });

  it("can't save or recover more than the MRR", () => {
    const e = estimateMonthlyFee({ mrrDollars: 1_000, cancelsPerMonth: 1_000, failedPerMonth: 0, arpuDollars: 100, saveRate: 1 });
    expect(e.savedMrrCents).toBe(100_000);
  });

  it("is zero when nothing churns", () => {
    const e = estimateMonthlyFee({ mrrDollars: 5_000, cancelsPerMonth: 0, failedPerMonth: 0, arpuDollars: 49 });
    expect(e.feeCents).toBe(0);
    expect(e.keptCents).toBe(0);
  });
});
