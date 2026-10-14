/**
 * Unquit pricing — the single source of truth for what a founder pays.
 *
 *   • $0 base fee.
 *   • Cancel save:  20% of the saved MRR, for each of the first 3 months the
 *                   saved customer keeps paying (so at most 60% of one month's MRR).
 *   • Dunning save: 10% of the recovered amount, once.
 *   • Overlap:      when ONE end-customer invoice earns both a cancel-save fee
 *                   (inside its 3-paid-invoice window) and a failed-payment
 *                   recovery fee, the cancel-save fee is charged in full and
 *                   the recovery fee is reduced to 5% (OVERLAP_RECOVERY_RATE).
 *                   Outside an overlap nothing changes (lib/ledger/overlap.ts).
 *   • Monthly cap:  a founder never pays more than $299 in a calendar month.
 *   • Clawback:     if the end customer is refunded (or a chargeback is lost),
 *                   the fee for that invoice is reversed pro-rata, rounded
 *                   in the founder's favour (lib/ledger/clawbacks.ts).
 *
 * All amounts are integer cents. Fees are rounded DOWN to the cent, so
 * rounding can never overcharge a founder.
 */

export const CANCEL_SAVE_RATE_BPS = 2000; // 20.00%, in basis points
export const DUNNING_SAVE_RATE_BPS = 1000; // 10.00%
/** Recovery fee on an invoice that also earns a cancel-save fee: half the normal 10%. */
export const OVERLAP_RECOVERY_RATE_BPS = 500; // 5.00%
export const OVERLAP_RECOVERY_RATE = OVERLAP_RECOVERY_RATE_BPS / 10_000; // 0.05
export const CANCEL_SAVE_BILLABLE_MONTHS = 3;
export const MONTHLY_FEE_CAP_CENTS = 29_900; // $299.00
export const BASE_FEE_CENTS = 0;

function assertCents(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative integer number of cents, got ${value}`);
  }
}

/** `amount × bps / 10_000`, rounded down. Integer-only maths, no float drift. */
function applyRate(amountCents: number, bps: number): number {
  return Math.floor((amountCents * bps) / 10_000);
}

/**
 * Fee for ONE month of a cancel save.
 * @param savedMrrCents  monthly recurring revenue kept by the save
 * @param monthIndex     1, 2 or 3 = first, second, third paid month after the save.
 *                       Month 4 and later earn nothing.
 */
export function cancelSaveMonthlyFeeCents(savedMrrCents: number, monthIndex: number): number {
  assertCents("savedMrrCents", savedMrrCents);
  if (!Number.isInteger(monthIndex) || monthIndex < 1) {
    throw new RangeError(`monthIndex must be an integer >= 1, got ${monthIndex}`);
  }
  if (monthIndex > CANCEL_SAVE_BILLABLE_MONTHS) return 0;
  return applyRate(savedMrrCents, CANCEL_SAVE_RATE_BPS);
}

/**
 * Total fee a cancel save has earned after the customer has paid
 * `paidMonths` invoices since the save (capped at 3 months).
 */
export function cancelSaveTotalFeeCents(savedMrrCents: number, paidMonths: number): number {
  assertCents("savedMrrCents", savedMrrCents);
  if (!Number.isInteger(paidMonths) || paidMonths < 0) {
    throw new RangeError(`paidMonths must be a non-negative integer, got ${paidMonths}`);
  }
  const billable = Math.min(paidMonths, CANCEL_SAVE_BILLABLE_MONTHS);
  return applyRate(savedMrrCents, CANCEL_SAVE_RATE_BPS) * billable;
}

/** Fee for a recovered failed payment: 10% of what was actually recovered. */
export function dunningSaveFeeCents(recoveredAmountCents: number): number {
  assertCents("recoveredAmountCents", recoveredAmountCents);
  return applyRate(recoveredAmountCents, DUNNING_SAVE_RATE_BPS);
}

/**
 * Recovery fee when the recovered invoice also earns a cancel-save fee (an
 * "overlap"): 5% of what was recovered, rounded down. Never more than the
 * normal recovery fee.
 */
export function overlapRecoveryFeeCents(recoveredAmountCents: number): number {
  assertCents("recoveredAmountCents", recoveredAmountCents);
  return Math.min(applyRate(recoveredAmountCents, OVERLAP_RECOVERY_RATE_BPS), dunningSaveFeeCents(recoveredAmountCents));
}

/** The line receipts and statements show for a reduced recovery fee. */
export const OVERLAP_RECOVERY_LABEL = "Recovery fee (reduced, overlaps an active save): 5%";

/** One plain sentence for every place pricing is explained. */
export const OVERLAP_PRICING_SENTENCE =
  "If a customer you saved from cancelling also has a failed payment recovered during their 3 paid months, that invoice pays the 20% save fee plus a reduced 5% recovery fee instead of 10%.";

export type FeeLine = {
  saveId: string;
  kind: "cancel" | "dunning";
  amountCents: number;
  /** True when the whole fee was reversed (refund, lost chargeback, accepted dispute). */
  clawedBack?: boolean;
  /** Part of the fee reversed by a partial refund (pro-rata). Ignored when clawedBack is true. */
  clawedBackCents?: number;
};

export type MonthlyBill = {
  /** Sum of all fee lines that still stand (clawbacks removed), before the cap. */
  grossCents: number;
  /** Fees removed because of refunds inside the window. */
  clawedBackCents: number;
  /** Amount knocked off by the $299 cap. */
  capDiscountCents: number;
  /** What the founder is actually charged this month. */
  totalCents: number;
  capCents: number;
  capReached: boolean;
};

/**
 * Builds a founder's bill for one calendar month from the fee lines earned in
 * that month. Clawed-back lines are excluded; the result is capped at $299.
 */
export function calculateMonthlyBill(lines: readonly FeeLine[], capCents: number = MONTHLY_FEE_CAP_CENTS): MonthlyBill {
  assertCents("capCents", capCents);
  let grossCents = BASE_FEE_CENTS;
  let clawedBackCents = 0;

  for (const line of lines) {
    assertCents(`fee line ${line.saveId}`, line.amountCents);
    if (line.clawedBack) {
      clawedBackCents += line.amountCents;
      continue;
    }
    const partial = Math.min(line.amountCents, Math.max(0, Math.trunc(line.clawedBackCents ?? 0)));
    clawedBackCents += partial;
    grossCents += line.amountCents - partial;
  }

  const totalCents = Math.min(grossCents, capCents);
  return {
    grossCents,
    clawedBackCents,
    capDiscountCents: grossCents - totalCents,
    totalCents,
    capCents,
    capReached: grossCents >= capCents,
  };
}

/**
 * How much more a founder can be charged this month before hitting the cap.
 * Useful for the dashboard's "Fees this month" card.
 */
export function remainingUnderCapCents(alreadyChargedCents: number, capCents: number = MONTHLY_FEE_CAP_CENTS): number {
  assertCents("alreadyChargedCents", alreadyChargedCents);
  return Math.max(0, capCents - alreadyChargedCents);
}

/** "$1,234.56" — display helper for integer cents. */
export function formatCents(cents: number, currency = "usd"): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: currency.toUpperCase(),
    minimumFractionDigits: 2,
  }).format(cents / 100);
}

export type CappedFee = {
  /** The fee the save earned (10% / 20%), recorded on the save before the cap. */
  earnedCents: number;
  /** The part of it the founder is actually charged this month. */
  chargedCents: number;
  /** The part waived because the $299 monthly cap was reached. */
  waivedCents: number;
};

/**
 * Applies the monthly cap to ONE new fee, given what the founder has already
 * earned (uncapped, clawbacks excluded) in the same calendar month. This is
 * the same rule `calculateMonthlyBill` applies to the whole month, one fee at
 * a time, so the dashboard and receipts can say "$X of this fee is waived".
 */
export function applyMonthlyCap(
  feeCents: number,
  earnedThisMonthCents: number,
  capCents: number = MONTHLY_FEE_CAP_CENTS,
): CappedFee {
  assertCents("feeCents", feeCents);
  assertCents("earnedThisMonthCents", earnedThisMonthCents);
  assertCents("capCents", capCents);
  const chargedCents = Math.min(feeCents, remainingUnderCapCents(Math.min(earnedThisMonthCents, capCents), capCents));
  return { earnedCents: feeCents, chargedCents, waivedCents: feeCents - chargedCents };
}
