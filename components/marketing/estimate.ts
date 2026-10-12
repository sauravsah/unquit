import {
  CANCEL_SAVE_BILLABLE_MONTHS,
  MONTHLY_FEE_CAP_CENTS,
  calculateMonthlyBill,
  cancelSaveTotalFeeCents,
  dunningSaveFeeCents,
} from "@/lib/pricing";

/**
 * The landing page's pricing calculator. All fee maths comes from lib/pricing;
 * this only turns slider positions into cents and states the assumptions.
 */

export const ASSUMED_SAVE_RATE = 0.25; // share of cancel attempts the flow keeps
export const ASSUMED_RECOVERY_RATE = 0.5; // share of failed payments unquit's emails/link recover

export const FLAT_FEE_TOOLS = [
  { name: "Churnkey", monthlyCents: 25_000 },
  { name: "ProsperStack", monthlyCents: 20_000 },
  { name: "Churn Buster", monthlyCents: 26_900 },
] as const;

export type EstimateInput = {
  mrrDollars: number;
  cancelsPerMonth: number;
  failedPerMonth: number;
  /** Average revenue per customer per month. */
  arpuDollars: number;
  saveRate?: number;
  recoveryRate?: number;
};

export type Estimate = {
  savedMrrCents: number;
  recoveredCents: number;
  cancelFeeCents: number;
  dunningFeeCents: number;
  /** What unquit charges in a steady-state month, after the $299 cap. */
  feeCents: number;
  capReached: boolean;
  /** Revenue kept that month (saved MRR + recovered payments). */
  keptCents: number;
  netCents: number;
};

const toCents = (dollars: number) => Math.max(0, Math.round(dollars * 100));

export function estimateMonthlyFee(input: EstimateInput): Estimate {
  const mrrCents = toCents(input.mrrDollars);
  const arpuCents = toCents(input.arpuDollars);
  const saveRate = input.saveRate ?? ASSUMED_SAVE_RATE;
  const recoveryRate = input.recoveryRate ?? ASSUMED_RECOVERY_RATE;

  // Can't lose (or fail to collect) more than the whole MRR.
  const cancellingCents = Math.min(Math.max(0, Math.floor(input.cancelsPerMonth)) * arpuCents, mrrCents);
  const failingCents = Math.min(Math.max(0, Math.floor(input.failedPerMonth)) * arpuCents, mrrCents);

  const savedMrrCents = Math.round(cancellingCents * saveRate);
  const recoveredCents = Math.round(failingCents * recoveryRate);

  // Steady state: each month's saves earn 20% for 3 months, so three cohorts
  // overlap in any month = 20% of one month's saved MRR × 3.
  const cancelFeeCents = cancelSaveTotalFeeCents(savedMrrCents, CANCEL_SAVE_BILLABLE_MONTHS);
  const dunningFeeCents = dunningSaveFeeCents(recoveredCents);
  const bill = calculateMonthlyBill([
    { saveId: "cancel", kind: "cancel", amountCents: cancelFeeCents },
    { saveId: "dunning", kind: "dunning", amountCents: dunningFeeCents },
  ]);

  const keptCents = savedMrrCents + recoveredCents;
  return {
    savedMrrCents,
    recoveredCents,
    cancelFeeCents,
    dunningFeeCents,
    feeCents: bill.totalCents,
    capReached: bill.capReached,
    keptCents,
    netCents: keptCents - bill.totalCents,
  };
}

export { MONTHLY_FEE_CAP_CENTS };
