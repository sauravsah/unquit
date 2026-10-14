/**
 * A founder's monthly statement, as pure maths (no database, no Stripe).
 *
 *   own fees  = every fee line assigned to the month: verified, not held,
 *               net of clawbacks, split into cancel saves and dunning recoveries
 *               (recoveries that overlapped a cancel save's window are at 5%)
 *   capped    = min(own fees, $299)
 *   credit    = refunds/disputes on fees that EARLIER statements already
 *               charged (re-computed with the cap, so a fee the cap had waived
 *               is never "refunded" twice), up to this month's capped amount;
 *               anything left over carries to the next statement
 *   total     = capped − credit   (what the Stripe invoice charges)
 */
import { MONTHLY_FEE_CAP_CENTS } from "@/lib/pricing";
import { netCents } from "@/lib/ledger/fees";

export type StatementLine = {
  id: string;
  saveId: string;
  kind: "cancel" | "dunning";
  amountCents: number;
  clawedBackCents: number;
  /** A recovery line reduced to 5% because its invoice also earned a cancel-save fee. */
  overlap?: boolean;
};

export type Statement = {
  cancelFeesCents: number;
  cancelLinesCount: number;
  dunningFeesCents: number;
  dunningLinesCount: number;
  /** The part of dunningFeesCents charged at the reduced overlap rate (5%), and how many lines. */
  overlapDunningFeesCents: number;
  overlapDunningLinesCount: number;
  clawedBackCents: number;
  grossCents: number;
  capCents: number;
  capDiscountCents: number;
  cappedCents: number;
  creditAppliedCents: number;
  totalCents: number;
  capReached: boolean;
};

export function buildStatement(
  lines: readonly StatementLine[],
  creditOwedCents = 0,
  capCents: number = MONTHLY_FEE_CAP_CENTS,
): Statement {
  let cancel = 0;
  let cancelCount = 0;
  let dunning = 0;
  let dunningCount = 0;
  let overlapDunning = 0;
  let overlapCount = 0;
  let clawed = 0;
  for (const line of lines) {
    const net = netCents({ amount_cents: line.amountCents, clawed_back_cents: line.clawedBackCents });
    clawed += Math.min(Number(line.amountCents), Number(line.clawedBackCents));
    if (net === 0) continue;
    if (line.kind === "cancel") {
      cancel += net;
      cancelCount++;
    } else {
      dunning += net;
      dunningCount++;
      if (line.overlap) {
        overlapDunning += net;
        overlapCount++;
      }
    }
  }
  const gross = cancel + dunning;
  const capped = Math.min(gross, capCents);
  const credit = Math.min(Math.max(0, Math.trunc(creditOwedCents)), capped);
  return {
    cancelFeesCents: cancel,
    cancelLinesCount: cancelCount,
    dunningFeesCents: dunning,
    dunningLinesCount: dunningCount,
    overlapDunningFeesCents: overlapDunning,
    overlapDunningLinesCount: overlapCount,
    clawedBackCents: clawed,
    grossCents: gross,
    capCents,
    capDiscountCents: gross - capped,
    cappedCents: capped,
    creditAppliedCents: credit,
    totalCents: capped - credit,
    capReached: gross >= capCents,
  };
}

/** What a closed statement's own fees come to NOW (after later clawbacks), with the cap. */
export function recomputeCapped(lines: readonly StatementLine[], capCents: number): number {
  return buildStatement(lines, 0, capCents).cappedCents;
}

export type ClosedPeriod = {
  id: string;
  cappedCents: number;
  capCents: number;
  creditAppliedCents: number;
  lines: StatementLine[];
};

/**
 * Credit owed to the founder from earlier statements: what each of them
 * charged for its own fees minus what those fees come to now, less credit
 * already given on other statements. Never negative: a statement is never
 * re-charged upwards.
 */
export function creditOwedCents(closed: readonly ClosedPeriod[]): number {
  let owed = 0;
  let applied = 0;
  for (const p of closed) {
    owed += Math.max(0, p.cappedCents - recomputeCapped(p.lines, p.capCents));
    applied += p.creditAppliedCents;
  }
  return Math.max(0, owed - applied);
}
