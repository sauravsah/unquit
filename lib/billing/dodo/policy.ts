/**
 * unquit's own collection policy for Dodo Payments on-demand charges.
 * Pure functions, no I/O. Follows Dodo's "safe retry policy"
 * (https://docs.dodopayments.com/developer-resources/ondemand-subscriptions#payment-retries):
 *
 *   attempt 1  immediately (the monthly run on the 1st)
 *   attempt 2  +3 days   } anchored to attempt 1's timestamp, so retries
 *   attempt 3  +10 days  } land at the same time of day and never burst
 *   attempt 4  +17 days  } (final). Then the statement is marked unpaid.
 *
 * Hard declines (https://docs.dodopayments.com/api-reference/transaction-failures)
 * are never retried with the same card: the statement goes unpaid at once and
 * the founder is asked to update their card.
 */

/** Charges below this are carried forward to the next statement instead (card fees, fraud heuristics). */
export const MIN_CHARGE_CENTS = 100; // $1.00

/** Days after the first attempt at which attempts 1..4 run. */
export const RETRY_OFFSETS_DAYS = [0, 3, 10, 17] as const;
export const MAX_ATTEMPTS = RETRY_OFFSETS_DAYS.length;
/** A card update starts a fresh cycle of attempts; never more than this many in total for one statement. */
export const MAX_TOTAL_ATTEMPTS = 8;

/**
 * The daily retry cron runs at a fixed time (06:00 UTC, the same as the
 * monthly run), so a retry due "at" that time may be picked up a little
 * before it on the day it is due. Anything due within this window counts.
 */
export const DUE_SLACK_MS = 2 * 60 * 60_000;

const DAY_MS = 86_400_000;

/**
 * When attempt `attemptNo` (1-based) should run, anchored to the first
 * attempt. Null when there is no such attempt (past the last one).
 */
export function attemptAt(firstAttemptAt: Date, attemptNo: number): Date | null {
  const offset = RETRY_OFFSETS_DAYS[attemptNo - 1];
  if (offset === undefined) return null;
  return new Date(firstAttemptAt.getTime() + offset * DAY_MS);
}

/**
 * Hard declines from Dodo's transaction-failure table ("Type: Hard"). A retry
 * with the same card can't succeed, and retrying some of them (stolen, lost,
 * fraudulent…) looks like card testing.
 */
export const HARD_DECLINE_CODES: ReadonlySet<string> = new Set([
  "AUTHENTICATION_FAILURE",
  "AUTHENTICATION_REQUIRED",
  "CUSTOMER_CANCELLED",
  "EXPIRED_CARD",
  "FRAUDULENT",
  "INCORRECT_CVC",
  "INCORRECT_NUMBER",
  "INVALID_ACCOUNT",
  "INVALID_AMOUNT",
  "INVALID_CARD_NUMBER",
  "INVALID_CARD_OWNER",
  "INVALID_CVC",
  "INVALID_EXPIRY_YEAR",
  "INVALID_PIN",
  "INVALID_REQUEST",
  "INVALID_UPI_ID",
  "LIVE_MODE_TEST_CARD",
  "LOST_CARD",
  "MANDATE_INVALID",
  "MANDATE_REQUIRED",
  "MANDATE_REQUIRED_SYSTEM",
  "ORDER_ALREADY_EXISTS",
  "PAYMENT_METHOD_PROVIDER_DECLINED",
  "PAYMENT_METHOD_UNSUPPORTED",
  "PICKUP_CARD",
  "PROVIDER_UNSUPPORTED",
  "REVOCATION_OF_AUTHORIZATION",
  "STOLEN_CARD",
  "SUBSCRIPTION_NOT_ACTIVE",
  "TRANSACTION_NOT_APPROVED",
  // API-level refusals that mean the mandate itself can't be charged.
  "SUBSCRIPTION_NOT_ON_DEMAND",
]);

/** Codes whose real reason must never be shown to the founder (Dodo's guidance). */
const CONCEALED = new Set(["STOLEN_CARD", "LOST_CARD", "PICKUP_CARD", "FRAUDULENT"]);

export function isHardDecline(code: string | null | undefined): boolean {
  return !!code && HARD_DECLINE_CODES.has(code.trim().toUpperCase());
}

export type FailureDecision =
  | { kind: "retry"; attemptNo: number; at: Date }
  | { kind: "unpaid"; reason: "hard_decline" | "retries_exhausted" };

/** What happens after attempt `attemptNo` failed with `code`. */
export function afterFailure(firstAttemptAt: Date, attemptNo: number, code: string | null | undefined): FailureDecision {
  if (isHardDecline(code)) return { kind: "unpaid", reason: "hard_decline" };
  const next = attemptAt(firstAttemptAt, attemptNo + 1);
  if (!next) return { kind: "unpaid", reason: "retries_exhausted" };
  return { kind: "retry", attemptNo: attemptNo + 1, at: next };
}

export type DueDecision = { kind: "charge"; amountCents: number } | { kind: "carry_forward"; amountCents: number } | { kind: "nothing" };

/** A statement's amount due: charge it, carry it forward (below the minimum), or nothing. */
export function decideDue(amountDueCents: number, minCents = MIN_CHARGE_CENTS): DueDecision {
  if (!Number.isInteger(amountDueCents) || amountDueCents < 0) throw new RangeError(`amount due must be non-negative cents, got ${amountDueCents}`);
  if (amountDueCents === 0) return { kind: "nothing" };
  if (amountDueCents < minCents) return { kind: "carry_forward", amountCents: amountDueCents };
  return { kind: "charge", amountCents: amountDueCents };
}

/** A founder-safe one-liner for a decline code. */
export function founderDeclineMessage(code: string | null | undefined): string {
  const c = (code ?? "").toUpperCase();
  if (!c) return "The payment didn't go through.";
  if (CONCEALED.has(c)) return "Your card was declined.";
  switch (c) {
    case "INSUFFICIENT_FUNDS":
      return "Your card has insufficient funds.";
    case "EXPIRED_CARD":
      return "Your card has expired.";
    case "AUTHENTICATION_REQUIRED":
    case "AUTHENTICATION_FAILURE":
      return "Your bank asked for extra authentication.";
    case "TRANSACTION_NOT_APPROVED":
      return "Your bank didn't approve the recurring payment.";
    case "LIMIT_EXCEEDED":
    case "CARD_VELOCITY_EXCEEDED":
      return "Your card's limit was reached.";
    case "SUBSCRIPTION_NOT_ACTIVE":
    case "MANDATE_INVALID":
    case "MANDATE_REQUIRED":
      return "Your saved card authorisation is no longer active.";
    default:
      return "Your card was declined.";
  }
}
