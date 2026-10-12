import { describe, expect, it } from "vitest";
import {
  MONTHLY_FEE_CAP_CENTS,
  applyMonthlyCap,
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

describe("dunning fees under the $299 monthly cap", () => {
  it("charges a dunning fee in full while the month is under the cap", () => {
    expect(applyMonthlyCap(dunningSaveFeeCents(4_900), 10_000)).toEqual({ earnedCents: 490, chargedCents: 490, waivedCents: 0 });
  });

  it("charges only what is left under the cap", () => {
    expect(applyMonthlyCap(dunningSaveFeeCents(50_000), 27_000)).toEqual({ earnedCents: 5_000, chargedCents: 2_900, waivedCents: 2_100 });
  });

  it("waives the whole fee once the cap is reached", () => {
    expect(applyMonthlyCap(490, MONTHLY_FEE_CAP_CENTS)).toEqual({ earnedCents: 490, chargedCents: 0, waivedCents: 490 });
    expect(applyMonthlyCap(490, 1_000_000)).toEqual({ earnedCents: 490, chargedCents: 0, waivedCents: 490 });
  });

  it("agrees with calculateMonthlyBill for a month of dunning saves", () => {
    const fees = [12_000, 9_000, 5_000, 4_900, 490].map((recovered, i) => ({ saveId: `s${i}`, kind: "dunning" as const, amountCents: recovered }));
    let earned = 0;
    let charged = 0;
    for (const f of fees) {
      charged += applyMonthlyCap(f.amountCents, earned).chargedCents;
      earned += f.amountCents;
    }
    expect(charged).toBe(calculateMonthlyBill(fees).totalCents);
    expect(charged).toBe(MONTHLY_FEE_CAP_CENTS);
  });

  it("rejects invalid input", () => {
    expect(() => applyMonthlyCap(-1, 0)).toThrow(RangeError);
    expect(() => applyMonthlyCap(1, 0.5)).toThrow(RangeError);
  });
});
