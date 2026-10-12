import { describe, expect, it } from "vitest";
import { LINK_TTL_DAYS, issueLinkToken, linkStatusForCase, signLinkToken, verifyLinkToken } from "./token";

const SECRET = "test-link-secret-0123456789abcdef0123456789";
const CASE = "6f1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
const NONCE = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
const now = new Date("2026-10-12T12:00:00Z");

describe("link tokens", () => {
  it("round-trips and expires after the TTL", () => {
    const token = issueLinkToken(CASE, NONCE, SECRET, now);
    expect(token).toMatch(/^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    const ok = verifyLinkToken(token, SECRET, now);
    expect(ok).toEqual({ ok: true, payload: { caseId: CASE, nonce: NONCE, expiresAtUnix: now.getTime() / 1000 + LINK_TTL_DAYS * 86_400 } });

    const almost = new Date(now.getTime() + LINK_TTL_DAYS * 86_400_000 - 1000);
    expect(verifyLinkToken(token, SECRET, almost).ok).toBe(true);
    const after = new Date(now.getTime() + LINK_TTL_DAYS * 86_400_000);
    expect(verifyLinkToken(token, SECRET, after)).toEqual({ ok: false, reason: "expired" });
  });

  it("rejects a token signed with another secret", () => {
    const token = issueLinkToken(CASE, NONCE, SECRET, now);
    expect(verifyLinkToken(token, `${SECRET}x`, now)).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("rejects an edited payload (e.g. a longer expiry or another case)", () => {
    const token = issueLinkToken(CASE, NONCE, SECRET, now);
    const [v, , sig] = token.split(".");
    const forged = Buffer.from(JSON.stringify({ c: CASE, n: NONCE, e: 9_999_999_999 })).toString("base64url");
    expect(verifyLinkToken(`${v}.${forged}.${sig}`, SECRET, now)).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("rejects garbage", () => {
    for (const bad of ["", "v1", "v1.a", "v2.a.b", "v1.a.b.c", "x".repeat(600), "v1.!!!.???"]) {
      expect(verifyLinkToken(bad, SECRET, now).ok).toBe(false);
    }
    const notUuid = signLinkToken({ caseId: "not-a-uuid", nonce: NONCE, expiresAtUnix: 9_999_999_999 }, SECRET);
    expect(verifyLinkToken(notUuid, SECRET, now)).toEqual({ ok: false, reason: "malformed" });
  });

  it("refuses a short secret", () => {
    expect(() => issueLinkToken(CASE, NONCE, "short", now)).toThrow(/32 characters/);
  });
});

describe("single use per success", () => {
  const payload = { caseId: CASE, nonce: NONCE, expiresAtUnix: 9_999_999_999 };

  it("works while the case is open and the nonce matches, including after a failed attempt", () => {
    expect(linkStatusForCase(payload, { status: "open", link_nonce: NONCE })).toBe("ok");
  });

  it("dies once a payment succeeded (case recovered and nonce rotated)", () => {
    expect(linkStatusForCase(payload, { status: "recovered", link_nonce: "11111111-2222-4333-8444-555555555555" })).toBe("used");
  });

  it("reports closed cases and unknown cases", () => {
    expect(linkStatusForCase(payload, { status: "closed", link_nonce: NONCE })).toBe("closed");
    expect(linkStatusForCase(payload, null)).toBe("not_found");
    expect(linkStatusForCase(payload, { status: "open", link_nonce: "11111111-2222-4333-8444-555555555555" })).toBe("used");
  });
});
