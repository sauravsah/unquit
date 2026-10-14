import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { decryptSecret, encryptSecret, KeyCryptoError, last4, parseEncryptionKey } from "./key-crypto";

const key = randomBytes(32);
const RK = "rk_test_51Abcdefghijklmnopqrstuvwxyz0123456789WXYZ";

describe("key-crypto (AES-256-GCM)", () => {
  it("round-trips and never contains the plain key", () => {
    const ct = encryptSecret(RK, key, "acct-1");
    expect(ct.startsWith("v1.")).toBe(true);
    expect(ct).not.toContain("rk_test");
    expect(decryptSecret(ct, key, "acct-1")).toBe(RK);
  });

  it("uses a fresh IV each time", () => {
    expect(encryptSecret(RK, key, "a")).not.toBe(encryptSecret(RK, key, "a"));
  });

  it("refuses the wrong key, the wrong account (AAD) and tampered data", () => {
    const ct = encryptSecret(RK, key, "acct-1");
    expect(() => decryptSecret(ct, randomBytes(32), "acct-1")).toThrow(KeyCryptoError);
    expect(() => decryptSecret(ct, key, "acct-2")).toThrow(KeyCryptoError);
    const parts = ct.split(".");
    const data = Buffer.from(parts[3]!, "base64url");
    data[0] = data[0]! ^ 1;
    parts[3] = data.toString("base64url");
    expect(() => decryptSecret(parts.join("."), key, "acct-1")).toThrow(KeyCryptoError);
    expect(() => decryptSecret("plain", key, "acct-1")).toThrow(KeyCryptoError);
  });

  it("parses base64, base64url and hex keys and fails closed otherwise", () => {
    const raw = randomBytes(32);
    expect(parseEncryptionKey(raw.toString("base64")).equals(raw)).toBe(true);
    expect(parseEncryptionKey(raw.toString("base64url")).equals(raw)).toBe(true);
    expect(parseEncryptionKey(raw.toString("hex")).equals(raw)).toBe(true);
    expect(() => parseEncryptionKey(undefined)).toThrow(/not set/);
    expect(() => parseEncryptionKey("")).toThrow(/not set/);
    expect(() => parseEncryptionKey("too-short")).toThrow(/32 random bytes/);
    expect(() => parseEncryptionKey(randomBytes(16).toString("base64"))).toThrow(/32 random bytes/);
  });

  it("shows only the last 4 characters", () => {
    expect(last4(RK)).toBe("WXYZ");
  });
});
