/**
 * Standard Webhooks signature verification (https://standardwebhooks.com),
 * the scheme Dodo Payments uses
 * (https://docs.dodopayments.com/developer-resources/webhooks#verifying-signatures):
 *
 *   signed content = `${webhook-id}.${webhook-timestamp}.${raw body}`
 *   key            = base64-decode(secret without the "whsec_" prefix)
 *   signature      = base64(HMAC-SHA256(key, signed content))
 *   header         = space-separated "v1,<signature>" entries; any match is valid
 *
 * Timestamps more than 5 minutes from now are rejected (replay protection).
 */
import { createHmac, timingSafeEqual } from "node:crypto";

export const WEBHOOK_TOLERANCE_SECONDS = 5 * 60;

export class WebhookVerificationError extends Error {
  constructor(
    message: string,
    readonly reason: "missing_headers" | "bad_secret" | "timestamp" | "signature",
  ) {
    super(message);
  }
}

export type WebhookHeaders = { id: string | null; timestamp: string | null; signature: string | null };

export function signingKey(secret: string): Buffer {
  const trimmed = secret.trim();
  const raw = trimmed.startsWith("whsec_") ? trimmed.slice("whsec_".length) : trimmed;
  if (!/^[A-Za-z0-9+/=_-]+$/.test(raw)) throw new WebhookVerificationError("Webhook secret is not base64", "bad_secret");
  const key = Buffer.from(raw.replace(/-/g, "+").replace(/_/g, "/"), "base64");
  if (key.length < 16) throw new WebhookVerificationError("Webhook secret is too short", "bad_secret");
  return key;
}

export function sign(secret: string, id: string, timestamp: string, body: string): string {
  return createHmac("sha256", signingKey(secret)).update(`${id}.${timestamp}.${body}`).digest("base64");
}

/** Throws WebhookVerificationError unless the request is authentic and fresh. */
export function verifyWebhook(secret: string, headers: WebhookHeaders, body: string, now: Date = new Date(), toleranceSeconds = WEBHOOK_TOLERANCE_SECONDS): void {
  const { id, timestamp, signature } = headers;
  if (!id || !timestamp || !signature) throw new WebhookVerificationError("Missing webhook-id, webhook-timestamp or webhook-signature", "missing_headers");
  if (!/^\d{1,12}$/.test(timestamp)) throw new WebhookVerificationError("Bad webhook-timestamp", "timestamp");
  const ts = Number(timestamp);
  if (Math.abs(now.getTime() / 1000 - ts) > toleranceSeconds) throw new WebhookVerificationError("webhook-timestamp is outside the tolerance", "timestamp");

  const expected = Buffer.from(sign(secret, id, timestamp, body));
  for (const part of signature.split(" ")) {
    const [version, value] = part.split(",", 2);
    if (version !== "v1" || !value) continue;
    const given = Buffer.from(value);
    if (given.length === expected.length && timingSafeEqual(given, expected)) return;
  }
  throw new WebhookVerificationError("No matching v1 signature", "signature");
}
