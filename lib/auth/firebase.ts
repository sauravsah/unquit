import "server-only";
import { createRemoteJWKSet, jwtVerify, SignJWT } from "jose";
import { randomBytes } from "crypto";
import { cookies } from "next/headers";
import { getDb } from "@/lib/db";
import { findUserByEmail, createUser, type PublicUser } from "./users";

const projectId = process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID;
const SESSION_COOKIE = process.env.NODE_ENV === "production" ? "__Secure-unquit.session" : "unquit.session";
const SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

type FirebaseClaims = { sub: string; email?: string; email_verified?: boolean };

function secretKey() {
  const secret = process.env.AUTH_SECRET || process.env.NEXTAUTH_SECRET;
  if (!secret) throw new Error("AUTH_SECRET is required for Firebase sessions.");
  return new TextEncoder().encode(secret);
}

function firebaseProjectId() {
  if (!projectId) throw new Error("Firebase is not configured.");
  return projectId;
}

export async function verifyFirebaseToken(token: string): Promise<FirebaseClaims> {
  const id = firebaseProjectId();
  const jwks = createRemoteJWKSet(new URL("https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com"));
  const { payload } = await jwtVerify(token, jwks, { issuer: `https://securetoken.google.com/${id}`, audience: id });
  if (typeof payload.sub !== "string") throw new Error("Invalid Firebase token.");
  return { sub: payload.sub, email: typeof payload.email === "string" ? payload.email.toLowerCase() : undefined, email_verified: payload.email_verified === true };
}

/** Maps a verified Firebase identity to Unquit's stable internal UUID. */
export async function firebaseUser(claims: FirebaseClaims): Promise<PublicUser> {
  if (!claims.email || !claims.email_verified) throw new Error("Verify your email before continuing.");
  const db = getDb();
  let user: PublicUser | null = await findUserByEmail(db, claims.email);
  if (!user) {
    user = await createUser(db, { email: claims.email, password: randomBytes(40).toString("base64url") });
  }
  await db.query("update users set firebase_uid = $1, email_verified_at = coalesce(email_verified_at, now()), last_sign_in_at = now() where id = $2", [claims.sub, user.id]);
  return { id: user.id, email: user.email };
}

export async function createFirebaseSession(user: PublicUser) {
  const token = await new SignJWT({ email: user.email }).setProtectedHeader({ alg: "HS256" }).setSubject(user.id).setIssuedAt().setExpirationTime(`${SESSION_MAX_AGE_SECONDS}s`).sign(secretKey());
  cookies().set(SESSION_COOKIE, token, { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax", path: "/", maxAge: SESSION_MAX_AGE_SECONDS });
}

export async function readFirebaseSession(): Promise<PublicUser | null> {
  try {
    const token = cookies().get(SESSION_COOKIE)?.value;
    if (!token) return null;
    const { payload } = await jwtVerify(token, secretKey());
    if (typeof payload.sub !== "string" || typeof payload.email !== "string") return null;
    return { id: payload.sub, email: payload.email };
  } catch { return null; }
}

export function firebaseSessionCookieName() { return SESSION_COOKIE; }
export function firebaseSessionSecret() { return process.env.AUTH_SECRET || process.env.NEXTAUTH_SECRET; }
export function clearFirebaseSession() { cookies().set(SESSION_COOKIE, "", { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax", path: "/", maxAge: 0 }); }
