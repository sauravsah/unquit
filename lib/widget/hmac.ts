import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Widget authentication.
 *
 * The founder's backend signs `${customerId}:${subscriptionId}` with the
 * account's signing secret (HMAC-SHA256, lowercase hex) and hands the result
 * to the browser. The widget sends it back; we recompute and compare. An end
 * user can't forge a signature for somebody else's customer or subscription
 * because they never see the secret.
 */

const ID = /^[A-Za-z0-9_]{3,255}$/;

export function hmacMessage(customerId: string, subscriptionId: string): string {
  return `${customerId}:${subscriptionId}`;
}

export function signCustomer(secret: string, customerId: string, subscriptionId: string): string {
  return createHmac("sha256", secret).update(hmacMessage(customerId, subscriptionId), "utf8").digest("hex");
}

/** Constant-time check of a widget HMAC. Never throws. */
export function verifyCustomerHmac(
  secret: string | null | undefined,
  customerId: unknown,
  subscriptionId: unknown,
  hmac: unknown,
): boolean {
  if (!secret || typeof customerId !== "string" || typeof subscriptionId !== "string" || typeof hmac !== "string") {
    return false;
  }
  if (!ID.test(customerId) || !ID.test(subscriptionId)) return false;
  if (!/^[0-9a-fA-F]{64}$/.test(hmac)) return false;
  const expected = Buffer.from(signCustomer(secret, customerId, subscriptionId), "hex");
  const given = Buffer.from(hmac.toLowerCase(), "hex");
  return expected.length === given.length && timingSafeEqual(expected, given);
}
