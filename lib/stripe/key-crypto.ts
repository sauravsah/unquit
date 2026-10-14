import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * AES-256-GCM for secrets Unquit must keep (a founder's Stripe restricted key
 * and the signing secret of the webhook endpoint Unquit created for them).
 *
 * Format: "v1.<iv>.<tag>.<ciphertext>", each part base64url. A fresh 12-byte IV
 * per value; the 16-byte tag authenticates both the data and the AAD, which is
 * always the owning account's id, so a ciphertext copied onto another account
 * row will not decrypt.
 *
 * Fails closed: a missing or malformed key throws, it never falls back to
 * storing or reading plain text.
 */

const VERSION = "v1";

export class KeyCryptoError extends Error {}

/** Parses STRIPE_KEY_ENCRYPTION_KEY: 32 bytes as base64/base64url (43-44 chars) or hex (64 chars). */
export function parseEncryptionKey(raw: string | undefined | null): Buffer {
  const value = (raw ?? "").trim();
  if (!value) throw new KeyCryptoError("STRIPE_KEY_ENCRYPTION_KEY is not set. Generate one with `openssl rand -base64 32`.");
  let key: Buffer | null = null;
  if (/^[0-9a-fA-F]{64}$/.test(value)) key = Buffer.from(value, "hex");
  else if (/^[A-Za-z0-9+/_-]{43}={0,1}$/.test(value)) key = Buffer.from(value.replace(/-/g, "+").replace(/_/g, "/"), "base64");
  if (!key || key.length !== 32) {
    throw new KeyCryptoError("STRIPE_KEY_ENCRYPTION_KEY must be 32 random bytes, base64 (`openssl rand -base64 32`) or 64 hex characters.");
  }
  return key;
}

export function encryptSecret(plaintext: string, key: Buffer, aad: string): string {
  if (key.length !== 32) throw new KeyCryptoError("Encryption key must be 32 bytes");
  if (!plaintext) throw new KeyCryptoError("Nothing to encrypt");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const data = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString("base64url"), tag.toString("base64url"), data.toString("base64url")].join(".");
}

export function decryptSecret(ciphertext: string, key: Buffer, aad: string): string {
  const parts = ciphertext.split(".");
  if (parts.length !== 4 || parts[0] !== VERSION) throw new KeyCryptoError("Unrecognised ciphertext format");
  const [, ivB64, tagB64, dataB64] = parts as [string, string, string, string];
  const iv = Buffer.from(ivB64, "base64url");
  const tag = Buffer.from(tagB64, "base64url");
  if (iv.length !== 12 || tag.length !== 16) throw new KeyCryptoError("Corrupt ciphertext");
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAAD(Buffer.from(aad, "utf8"));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(Buffer.from(dataB64, "base64url")), decipher.final()]).toString("utf8");
  } catch {
    throw new KeyCryptoError("Could not decrypt: wrong key, wrong account or tampered data");
  }
}

/** Last 4 characters, the only part of a key ever shown back. */
export function last4(secret: string): string {
  return secret.slice(-4);
}
