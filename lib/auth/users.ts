import "server-only";
import bcrypt from "bcryptjs";
import { attempt, isUniqueViolation, queryOne, type Db } from "@/lib/db/core";

/**
 * Founder logins (email + password) on the `users` table (db/migrations/0005_auth.sql).
 *
 * TODO(email): no email provider is set up for auth yet (no verified Resend
 * domain), so there are no magic links, password resets or email verification.
 * When there is: send a verification link on sign-up, set email_verified_at,
 * and add a "forgot password" flow.
 */

export type UserRow = { id: string; email: string; password_hash: string; created_at: string };
export type PublicUser = { id: string; email: string };

export const MIN_PASSWORD_LENGTH = 8;
export const MAX_PASSWORD_LENGTH = 72; // bcrypt ignores anything past 72 bytes
const BCRYPT_COST = 12;
const EMAIL = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/;

export function normalizeEmail(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const email = raw.trim().toLowerCase();
  return email.length <= 254 && EMAIL.test(email) ? email : null;
}

/** Problems with a sign-up form, in the order the form shows them. Empty = fine. */
export function signUpErrors(input: { email?: unknown; password?: unknown }): string[] {
  const errors: string[] = [];
  if (!normalizeEmail(input.email)) errors.push("Enter a valid email address.");
  const password = typeof input.password === "string" ? input.password : "";
  if (password.length < MIN_PASSWORD_LENGTH) errors.push(`Use at least ${MIN_PASSWORD_LENGTH} characters for your password.`);
  else if (Buffer.byteLength(password, "utf8") > MAX_PASSWORD_LENGTH) errors.push(`Keep your password under ${MAX_PASSWORD_LENGTH} characters.`);
  return errors;
}

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, BCRYPT_COST);
}

export async function findUserByEmail(db: Db, email: string): Promise<UserRow | null> {
  const normalized = normalizeEmail(email);
  if (!normalized) return null;
  return attempt("Loading user", () =>
    queryOne<UserRow>(db, "select id, email, password_hash, created_at from users where email = $1", [normalized]),
  );
}

export class EmailTakenError extends Error {
  constructor() {
    super("An account with that email already exists. Sign in instead.");
  }
}

/** Creates a login. Throws EmailTakenError when the email is already registered. */
export async function createUser(db: Db, input: { email: string; password: string }): Promise<PublicUser> {
  const errors = signUpErrors(input);
  if (errors.length) throw new Error(errors[0]);
  const email = normalizeEmail(input.email)!;
  const passwordHash = await hashPassword(input.password);
  try {
    const row = await queryOne<PublicUser>(db, "insert into users (email, password_hash) values ($1, $2) returning id, email", [email, passwordHash]);
    if (!row) throw new Error("no row returned");
    return row;
  } catch (error) {
    if (isUniqueViolation(error)) throw new EmailTakenError();
    return attempt("Creating user", () => Promise.reject(error));
  }
}

// Compared against when the email is unknown, so a wrong email takes as long as a wrong password.
const DUMMY_HASH = "$2b$12$ofx4fgGtIZalUVBZzSwb1edw0YMOigVQOEsSrd.YhRDuVtyzzvcTm";

/** The user when the email + password match, else null. Records the sign-in time. */
export async function verifyCredentials(db: Db, emailRaw: unknown, passwordRaw: unknown): Promise<PublicUser | null> {
  const email = normalizeEmail(emailRaw);
  const password = typeof passwordRaw === "string" ? passwordRaw : "";
  if (!email || !password || Buffer.byteLength(password, "utf8") > MAX_PASSWORD_LENGTH) return null;
  const user = await findUserByEmail(db, email);
  const ok = await bcrypt.compare(password, user?.password_hash ?? DUMMY_HASH);
  if (!user || !ok) return null;
  await db.query("update users set last_sign_in_at = now() where id = $1", [user.id]).catch(() => {});
  return { id: user.id, email: user.email };
}
