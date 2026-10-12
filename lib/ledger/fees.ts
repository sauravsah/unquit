/**
 * Pure fee-line maths shared by clawbacks, the dashboard, receipts and
 * billing. Integer cents only.
 */
import type { FeeLineRow } from "./types";

type LineMoney = Pick<FeeLineRow, "amount_cents" | "clawed_back_cents">;
type LineHolds = Pick<FeeLineRow, "held_stripe_dispute_id" | "held_founder_dispute_id">;

/** What a line still earns after clawbacks. */
export function netCents(line: LineMoney): number {
  return Math.max(0, Number(line.amount_cents) - Number(line.clawed_back_cents ?? 0));
}

/** Held lines are not billed until the Stripe dispute or the founder's dispute is settled. */
export function isHeld(line: LineHolds): boolean {
  return !!line.held_stripe_dispute_id || !!line.held_founder_dispute_id;
}

/**
 * How much of a fee is clawed back when `returnedCents` of an invoice that
 * paid `paidCents` went back to the customer. Pro-rata, rounded UP to the
 * cent (fees round down, so rounding always lands in the founder's favour),
 * never more than the fee. A 0-paid invoice returns the whole fee.
 */
export function proRataClawbackCents(feeCents: number, returnedCents: number, paidCents: number): number {
  const fee = BigInt(Math.max(0, Math.trunc(feeCents)));
  const paid = BigInt(Math.max(0, Math.trunc(paidCents)));
  const returned = BigInt(Math.max(0, Math.trunc(returnedCents)));
  if (fee === 0n || returned === 0n) return 0;
  if (paid === 0n || returned >= paid) return Number(fee);
  const numerator = fee * returned;
  const ceil = (numerator + paid - 1n) / paid;
  return Number(ceil > fee ? fee : ceil);
}

/** "2026-10-01" for the month containing `date` (UTC). */
export function monthKey(date: Date): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-01`;
}

/** The month before `monthKey` ("2026-10-01" -> "2026-09-01"). */
export function previousMonthKey(key: string): string {
  const [y, m] = key.split("-").map(Number) as [number, number];
  const d = new Date(Date.UTC(y, m - 2, 1));
  return monthKey(d);
}

/** "2026-09" (URL form) <-> "2026-09-01" (database form). */
export function monthFromSlug(slug: string): string | null {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(slug)) return null;
  return `${slug}-01`;
}

export function monthSlug(key: string): string {
  return key.slice(0, 7);
}

/** "September 2026". */
export function monthLabel(key: string): string {
  const [y, m] = key.split("-").map(Number) as [number, number];
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
}
