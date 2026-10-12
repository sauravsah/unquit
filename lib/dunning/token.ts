/**
 * Card-update link tokens: `/u/<token>`.
 *
 * No login: the token IS the permission, so it is
 *   * signed     HMAC-SHA256 with DUNNING_LINK_SECRET (can't be forged or edited)
 *   * expiring   each email's link works for LINK_TTL_DAYS
 *   * tied       to one dunning case AND that case's current `link_nonce`
 *   * single-use-per-success: when a payment succeeds the case is recovered
 *                and its nonce rotated, so every link for it stops working.
 *                A failed attempt leaves the link usable so the customer can
 *                try another card.
 *
 * Format: `v1.<base64url(JSON {c, n, e})>.<base64url(HMAC)>`
 */
import { createHmac, timingSafeEqual } from "node:crypto";

export const LINK_TTL_DAYS = 14;
const VERSION = "v1";

export type LinkPayload = { caseId: string; nonce: string; expiresAtUnix: number };

export type VerifyResult =
  | { ok: true; payload: LinkPayload }
  | { ok: false; reason: "malformed" | "bad_signature" | "expired" };

function b64url(data: Buffer | string): string {
  return Buffer.from(data).toString("base64url");
}

function sign(body: string, secret: string): Buffer {
  if (!secret || secret.length < 32) throw new Error("DUNNING_LINK_SECRET must be at least 32 characters.");
  return createHmac("sha256", secret).update(`${VERSION}.${body}`).digest();
}

export function signLinkToken(payload: LinkPayload, secret: string): string {
  const body = b64url(JSON.stringify({ c: payload.caseId, n: payload.nonce, e: payload.expiresAtUnix }));
  return `${VERSION}.${body}.${b64url(sign(body, secret))}`;
}

/** A token for `caseId` that expires LINK_TTL_DAYS after `now`. */
export function issueLinkToken(caseId: string, nonce: string, secret: string, now: Date, ttlDays = LINK_TTL_DAYS): string {
  return signLinkToken({ caseId, nonce, expiresAtUnix: Math.floor(now.getTime() / 1000) + ttlDays * 86_400 }, secret);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function verifyLinkToken(token: string, secret: string, now: Date): VerifyResult {
  if (typeof token !== "string" || token.length > 512) return { ok: false, reason: "malformed" };
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== VERSION) return { ok: false, reason: "malformed" };
  const [, body, sig] = parts as [string, string, string];

  const expected = sign(body, secret);
  const given = Buffer.from(sig, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return { ok: false, reason: "bad_signature" };

  let parsed: { c?: unknown; n?: unknown; e?: unknown };
  try {
    parsed = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (typeof parsed.c !== "string" || !UUID.test(parsed.c) || typeof parsed.n !== "string" || !UUID.test(parsed.n)) {
    return { ok: false, reason: "malformed" };
  }
  if (typeof parsed.e !== "number" || !Number.isInteger(parsed.e)) return { ok: false, reason: "malformed" };
  if (parsed.e * 1000 <= now.getTime()) return { ok: false, reason: "expired" };

  return { ok: true, payload: { caseId: parsed.c, nonce: parsed.n, expiresAtUnix: parsed.e } };
}

export type LinkCaseState = { status: string; link_nonce: string };

/**
 * Checks a verified token against its case.
 *   ok     the link can be used to pay
 *   used   a payment through some link already succeeded (nonce rotated)
 *   closed the case is no longer open (paid elsewhere, cancelled, …)
 */
export function linkStatusForCase(payload: LinkPayload, c: LinkCaseState | null): "ok" | "used" | "closed" | "not_found" {
  if (!c) return "not_found";
  if (c.status === "recovered" && c.link_nonce !== payload.nonce) return "used";
  if (c.status !== "open") return "closed";
  if (c.link_nonce !== payload.nonce) return "used";
  return "ok";
}
