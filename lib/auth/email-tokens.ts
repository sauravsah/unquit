import "server-only";
import { createHash, randomBytes } from "crypto";
import { queryOne, type Db } from "@/lib/db/core";
import { hashPassword } from "./users";

export type TokenPurpose = "verify_email" | "reset_password";
const digest = (token: string) => createHash("sha256").update(token).digest("hex");

export async function createEmailToken(db: Db, userId: string, purpose: TokenPurpose): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  await db.query("delete from auth_email_tokens where user_id = $1 and purpose = $2 and used_at is null", [userId, purpose]);
  await db.query(
    "insert into auth_email_tokens (user_id, purpose, token_hash, expires_at) values ($1, $2, $3, now() + interval '1 hour')",
    [userId, purpose, digest(token)],
  );
  return token;
}

export async function consumeEmailToken(db: Db, token: string, purpose: TokenPurpose, password?: string): Promise<boolean> {
  if (!/^[A-Za-z0-9_-]{40,}$/.test(token)) return false;
  const row = await queryOne<{ user_id: string }>(
    db,
    "update auth_email_tokens set used_at = now() where token_hash = $1 and purpose = $2 and used_at is null and expires_at > now() returning user_id",
    [digest(token), purpose],
  );
  if (!row) return false;
  if (purpose === "verify_email") await db.query("update users set email_verified_at = coalesce(email_verified_at, now()) where id = $1", [row.user_id]);
  if (purpose === "reset_password" && password) await db.query("update users set password_hash = $1 where id = $2", [await hashPassword(password), row.user_id]);
  return true;
}
