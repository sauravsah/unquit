/**
 * Decline categorisation: decides which email sequence a failed payment gets.
 *
 *   soft                     the card is fine, the moment wasn't (no funds today,
 *                            a network blip). Stripe Smart Retries usually win;
 *                            Unquit sends a gentle heads-up.
 *   hard                     the card itself won't work again (expired, lost,
 *                            blocked). Only a new card fixes it: "update your card".
 *   authentication_required  the bank wants the customer to approve the payment
 *                            (SCA / 3-D Secure). Also "update your card": the page
 *                            runs 3DS while the customer is there.
 *
 * Inputs are Stripe's `decline_code` (issuer reason, e.g. insufficient_funds)
 * and `code` (Stripe's error code, e.g. card_declined, expired_card). The
 * decline code is more specific, so it wins when it is known.
 */

export type DeclineCategory = "soft" | "hard" | "authentication_required";

export const DECLINE_CATEGORIES: readonly DeclineCategory[] = ["soft", "hard", "authentication_required"];

const AUTHENTICATION = new Set([
  "authentication_required",
  "authentication_not_handled",
  "invoice_payment_intent_requires_action",
  "payment_intent_authentication_failure",
  "payment_intent_action_required",
  "setup_intent_authentication_failure",
  "offline_pin_required",
  "online_or_offline_pin_required",
]);

/** Temporary: the same card can succeed on a later attempt. */
const SOFT = new Set([
  "insufficient_funds",
  "processing_error",
  "try_again_later",
  "issuer_not_available",
  "reenter_transaction",
  "approve_with_id",
  "call_issuer",
  "card_velocity_exceeded",
  "withdrawal_count_limit_exceeded",
  "rate_limit",
  "card_decline_rate_limit_exceeded",
  "lock_timeout",
  "duplicate_transaction",
]);

/** Permanent for this card: ask for a new one. */
const HARD = new Set([
  "expired_card",
  "card_declined",
  "do_not_honor",
  "do_not_try_again",
  "generic_decline",
  "lost_card",
  "stolen_card",
  "pickup_card",
  "restricted_card",
  "fraudulent",
  "merchant_blacklist",
  "security_violation",
  "invalid_account",
  "new_account_information_available",
  "card_not_supported",
  "currency_not_supported",
  "transaction_not_allowed",
  "not_permitted",
  "service_not_allowed",
  "revocation_of_authorization",
  "revocation_of_all_authorizations",
  "stop_payment_order",
  "incorrect_number",
  "invalid_number",
  "incorrect_cvc",
  "invalid_cvc",
  "invalid_expiry_month",
  "invalid_expiry_year",
  "incorrect_zip",
  "incorrect_pin",
  "invalid_pin",
  "pin_try_exceeded",
  "no_action_taken",
  "testmode_decline",
  "expired_payment_method",
  "payment_method_not_available",
]);

function normalise(code: string | null | undefined): string | null {
  if (!code) return null;
  const c = code.trim().toLowerCase();
  return c === "" ? null : c;
}

function classify(code: string): DeclineCategory | null {
  if (AUTHENTICATION.has(code)) return "authentication_required";
  if (SOFT.has(code)) return "soft";
  if (HARD.has(code)) return "hard";
  return null;
}

/**
 * Category for a failed payment.
 * Unknown or missing codes are treated as `hard`: asking for a new card is the
 * safe default when we can't tell (the page also offers "try my card again").
 */
export function categorizeDecline(input: { declineCode?: string | null; errorCode?: string | null }): DeclineCategory {
  const decline = normalise(input.declineCode);
  const error = normalise(input.errorCode);
  return (decline && classify(decline)) ?? (error && classify(error)) ?? "hard";
}

/** The most useful single code to show a founder ("insufficient_funds" over "card_declined"). */
export function primaryDeclineCode(input: { declineCode?: string | null; errorCode?: string | null }): string | null {
  return normalise(input.declineCode) ?? normalise(input.errorCode);
}

/** Plain-English label for the dashboard. */
export function describeDeclineCode(code: string | null): string {
  if (!code) return "Unknown reason";
  const labels: Record<string, string> = {
    insufficient_funds: "Insufficient funds",
    processing_error: "Processing error",
    try_again_later: "Try again later",
    expired_card: "Expired card",
    card_declined: "Card declined",
    do_not_honor: "Do not honor",
    generic_decline: "Generic decline",
    lost_card: "Lost card",
    stolen_card: "Stolen card",
    authentication_required: "Needs 3-D Secure",
    incorrect_cvc: "Incorrect CVC",
    fraudulent: "Flagged as fraud",
  };
  return labels[code] ?? code.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
}

export const CATEGORY_LABELS: Record<DeclineCategory, string> = {
  soft: "Soft decline",
  hard: "Hard decline",
  authentication_required: "Needs authentication",
};
