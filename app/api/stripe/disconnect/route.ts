import { NextResponse } from "next/server";
import { isSameOrigin } from "@/lib/http";
import { serverEnv } from "@/lib/env";
import { getStripe } from "@/lib/stripe/client";
import { getSessionUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db";
import { findAccountForUser, markStripeDisconnected } from "@/lib/accounts";

export const dynamic = "force-dynamic";

/** Disconnects the founder's Stripe account from Unquit (revokes OAuth access). */
export async function POST(request: Request) {
  if (!isSameOrigin(request)) {
    return NextResponse.json({ error: "Bad origin" }, { status: 403 });
  }

  const db = getDb();
  const user = await getSessionUser();
  if (!user) return NextResponse.redirect(new URL("/login", request.url), 303);

  const account = await findAccountForUser(db, user.id);

  if (account?.stripe_account_id && account.stripe_connection_status === "connected") {
    try {
      await getStripe().oauth.deauthorize({
        client_id: serverEnv.stripeConnectClientId(),
        stripe_user_id: account.stripe_account_id,
      });
    } catch (err) {
      // Already revoked on Stripe's side: carry on and mark it locally.
      console.warn("[stripe/disconnect] deauthorize failed, marking disconnected anyway", err);
    }

    await markStripeDisconnected(db, account.id, new Date().toISOString());
  }

  return NextResponse.redirect(new URL("/dashboard?stripe=disconnected", request.url), 303);
}
