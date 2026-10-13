import { NextResponse } from "next/server";
import { createBillingRepo } from "@/lib/billing/repo";
import { ensurePlatformCustomer } from "@/lib/billing/service";
import { createBillingStripe, createSetupCheckout } from "@/lib/billing/stripe-ops";
import { publicEnv } from "@/lib/env";
import { isSameOrigin } from "@/lib/http";
import { getStripe } from "@/lib/stripe/client";
import { getSessionUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db";
import { findAccountForUser } from "@/lib/accounts";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * "Add a card" on /dashboard/billing: sends the founder to Stripe Checkout in
 * SETUP mode on unquit's own Stripe account (no charge now). Stripe brings
 * them back to /dashboard/billing?setup=success&session_id=…, which makes the
 * card the default for unquit's monthly invoices.
 */
export async function POST(request: Request) {
  if (!isSameOrigin(request)) return NextResponse.json({ error: "Bad origin" }, { status: 403 });
  const db = getDb();
  const user = await getSessionUser();
  if (!user) return NextResponse.redirect(new URL("/login?next=/dashboard/billing", request.url), { status: 303 });

  const account = await findAccountForUser(db, user.id).catch(() => null);
  if (!account) return NextResponse.redirect(new URL("/dashboard/billing?setup=error", request.url), { status: 303 });

  try {
    const stripe = getStripe();
    const customerId = await ensurePlatformCustomer(createBillingRepo(db), createBillingStripe(stripe), account.id);
    const base = publicEnv.appUrl();
    const url = await createSetupCheckout(stripe, {
      customerId,
      accountId: account.id,
      successUrl: `${base}/dashboard/billing?setup=success&session_id={CHECKOUT_SESSION_ID}`,
      cancelUrl: `${base}/dashboard/billing?setup=cancelled`,
    });
    return NextResponse.redirect(url, { status: 303 });
  } catch (e) {
    console.error("[billing/setup] could not start Checkout", e);
    return NextResponse.redirect(new URL("/dashboard/billing?setup=error", request.url), { status: 303 });
  }
}
