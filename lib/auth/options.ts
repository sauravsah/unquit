import "server-only";
import type { NextAuthOptions } from "next-auth";
import CredentialsProvider from "next-auth/providers/credentials";
import { getDb } from "@/lib/db";
import { firstSet } from "@/lib/env";
import { underRateLimit } from "@/lib/rate-limit";
import { normalizeEmail, verifyCredentials } from "./users";

/**
 * Auth.js (next-auth v4, the stable line for Next 14.2): email + password via
 * the Credentials provider, JWT sessions in an encrypted cookie (no session
 * table). The token carries the user id (`sub`) and email.
 *
 * Env: AUTH_SECRET (NEXTAUTH_SECRET also accepted). The public URL comes from
 * NEXTAUTH_URL, then AUTH_URL, then NEXT_PUBLIC_APP_URL.
 *
 * TODO(email): no magic links / email verification / password reset until an
 * email provider (a verified Resend domain) is set up. See lib/auth/users.ts.
 */

// next-auth v4 reads NEXTAUTH_URL itself; fill it from our fallbacks.
const url = firstSet(process.env.NEXTAUTH_URL, process.env.AUTH_URL, process.env.NEXT_PUBLIC_APP_URL);
if (url && !process.env.NEXTAUTH_URL) process.env.NEXTAUTH_URL = url;

export const SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

export function authSecret(): string | undefined {
  return firstSet(process.env.AUTH_SECRET, process.env.NEXTAUTH_SECRET);
}

function clientIp(headers: Record<string, unknown> | undefined): string {
  const forwarded = headers?.["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded) return forwarded.split(",")[0]!.trim();
  const real = headers?.["x-real-ip"];
  return typeof real === "string" && real ? real : "unknown";
}

export const authOptions: NextAuthOptions = {
  secret: authSecret(),
  session: { strategy: "jwt", maxAge: SESSION_MAX_AGE_SECONDS },
  pages: { signIn: "/login", signOut: "/signout", error: "/login" },
  providers: [
    CredentialsProvider({
      name: "Email and password",
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Password", type: "password" },
      },
      async authorize(credentials, req) {
        const email = normalizeEmail(credentials?.email);
        if (!email || !credentials?.password) return null;
        const db = getDb();
        // Brute-force guard: per email and per IP, 10 tries / 10 minutes.
        const ip = clientIp(req?.headers as Record<string, unknown> | undefined);
        const allowed =
          (await underRateLimit(db, `login-email:${email}`, 600, 10, "auth")) && (await underRateLimit(db, `login-ip:${ip}`, 600, 30, "auth"));
        if (!allowed) throw new Error("rate_limited");
        const user = await verifyCredentials(db, email, credentials.password);
        return user ? { id: user.id, email: user.email } : null;
      },
    }),
  ],
  callbacks: {
    async jwt({ token, user }) {
      if (user) {
        token.sub = user.id;
        token.email = user.email;
      }
      return token;
    },
    async session({ session, token }) {
      if (session.user) {
        (session.user as { id?: string }).id = token.sub;
        session.user.email = token.email ?? session.user.email;
      }
      return session;
    },
  },
};
