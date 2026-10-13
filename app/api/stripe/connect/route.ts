import { randomBytes } from "node:crypto";
import { NextResponse } from "next/server";
import { getOrCreateAccount } from "@/lib/accounts";
import { publicEnv, serverEnv } from "@/lib/env";
import { getStripe } from "@/lib/stripe/client";
import { OAUTH_STATE_COOKIE, OAUTH_STATE_COOKIE_PATH } from "@/lib/stripe/oauth";
import { getSessionUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db";

export const dynamic = "force-dynamic";

/**
 * Step 1 of Stripe Connect (Standard accounts, OAuth):
 * sends the founder to Stripe to approve Unquit.
 */
export async function GET(request: Request) {
  const db = getDb();
  const user = await getSessionUser();
  if (!user) return NextResponse.redirect(new URL("/login?next=/dashboard", request.url));

  await getOrCreateAccount(db, user);

  // Random `state` ties the callback to this browser (CSRF protection).
  const state = randomBytes(24).toString("base64url");

  const url = getStripe().oauth.authorizeUrl({
    response_type: "code",
    client_id: serverEnv.stripeConnectClientId(),
    scope: "read_write",
    redirect_uri: `${publicEnv.appUrl()}/api/stripe/callback`,
    state,
    stripe_user: user.email ? { email: user.email } : undefined,
  });

  const response = NextResponse.redirect(url);
  response.cookies.set(OAUTH_STATE_COOKIE, state, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: OAUTH_STATE_COOKIE_PATH,
    maxAge: 60 * 10,
  });
  return response;
}
