import { describe, expect, it } from "vitest";
import {
  MONTHLY_FEE_CAP_CENTS,
  calculateMonthlyBill,
  cancelSaveMonthlyFeeCents,
  cancelSaveTotalFeeCents,
  dunningSaveFeeCents,
  formatCents,
  remainingUnderCapCents,
} from "./pricing";

describe("cancel saves: 20% of saved MRR for the first 3 months", () => {
  it("charges 20% of MRR in months 1–3", () => {
    expect(cancelSaveMonthlyFeeCents(10_000, 1)).toBe(2_000); // $100 MRR -> $20
    expect(cancelSaveMonthlyFeeCents(10_000, 2)).toBe(2_000);
    expect(cancelSaveMonthlyFeeCents(10_000, 3)).toBe(2_000);
  });

  it("charges nothing from month 4 onwards", () => {
    expect(cancelSaveMonthlyFeeCents(10_000, 4)).toBe(0);
    expect(cancelSaveMonthlyFeeCents(10_000, 12)).toBe(0);
  });

  it("totals at most 3 months", () => {
    expect(cancelSaveTotalFeeCents(10_000, 0)).toBe(0);
    expect(cancelSaveTotalFeeCents(10_000, 1)).toBe(2_000);
    expect(cancelSaveTotalFeeCents(10_000, 3)).toBe(6_000);
    expect(cancelSaveTotalFeeCents(10_000, 10)).toBe(6_000);
  });

  it("rounds down so a founder is never overcharged", () => {
    expect(cancelSaveMonthlyFeeCents(999, 1)).toBe(199); // 199.8 -> 199
    expect(cancelSaveMonthlyFeeCents(1, 1)).toBe(0);
  });

  it("rejects invalid input", () => {
    expect(() => cancelSaveMonthlyFeeCents(-1, 1)).toThrow(RangeError);
    expect(() => cancelSaveMonthlyFeeCents(10.5, 1)).toThrow(RangeError);
    expect(() => cancelSaveMonthlyFeeCents(1_000, 0)).toThrow(RangeError);
    expect(() => cancelSaveTotalFeeCents(1_000, -1)).toThrow(RangeError);
  });
});

describe("dunning saves: 10% of the recovered amount", () => {
  it("charges 10%", () => {
    expect(dunningSaveFeeCents(4_900)).toBe(490); // $49 -> $4.90
    expect(dunningSaveFeeCents(0)).toBe(0);
  });

  it("rounds down", () => {
    expect(dunningSaveFeeCents(4_999)).toBe(499);
  });

  it("rejects negative or fractional cents", () => {
    expect(() => dunningSaveFeeCents(-100)).toThrow(RangeError);
    expect(() => dunningSaveFeeCents(1.2)).toThrow(RangeError);
  });
});

describe("monthly bill: $0 base, $299 cap, clawbacks removed", () => {
  it("is $0 with no saves", () => {
    const bill = calculateMonthlyBill([]);
    expect(bill.totalCents).toBe(0);
    expect(bill.capReached).toBe(false);
  });

  it("sums fee lines under the cap", () => {
    const bill = calculateMonthlyBill([
      { saveId: "a", kind: "cancel", amountCents: 2_000 },
      { saveId: "b", kind: "dunning", amountCents: 490 },
    ]);
    expect(bill.grossCents).toBe(2_490);
    expect(bill.totalCents).toBe(2_490);
    expect(bill.capDiscountCents).toBe(0);
  });

  it("never exceeds $299", () => {
    const lines = Array.from({ length: 20 }, (_, i) => ({
      saveId: `s${i}`,
      kind: "cancel" as const,
      amountCents: 2_000,
    })); // $400 gross
    const bill = calculateMonthlyBill(lines);
    expect(bill.grossCents).toBe(40_000);
    expect(bill.totalCents).toBe(MONTHLY_FEE_CAP_CENTS);
    expect(bill.capDiscountCents).toBe(40_000 - 29_900);
    expect(bill.capReached).toBe(true);
  });

  it("removes clawed-back fees before applying the cap", () => {
    const bill = calculateMonthlyBill([
      { saveId: "a", kind: "cancel", amountCents: 20_000 },
      { saveId: "b", kind: "cancel", amountCents: 20_000, clawedBack: true },
    ]);
    expect(bill.grossCents).toBe(20_000);
    expect(bill.clawedBackCents).toBe(20_000);
    expect(bill.totalCents).toBe(20_000);
    expect(bill.capReached).toBe(false);
  });

  it("reports room left under the cap", () => {
    expect(remainingUnderCapCents(0)).toBe(29_900);
    expect(remainingUnderCapCents(29_000)).toBe(900);
    expect(remainingUnderCapCents(50_000)).toBe(0);
  });
});

describe("formatCents", () => {
  it("formats as dollars", () => {
    expect(formatCents(29_900)).toBe("$299.00");
    expect(formatCents(123_456)).toBe("$1,234.56");
    expect(formatCents(0)).toBe("$0.00");
  });
});
