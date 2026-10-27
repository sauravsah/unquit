import { NextResponse } from "next/server";
import { findAccountForUser } from "@/lib/accounts";
import { getSessionUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db";
import { isSameOrigin } from "@/lib/http";
import { getStripeResolver } from "@/lib/stripe/client";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Creates a harmless fixture for the dashboard widget tester. This route is
 * deliberately limited to a connected test-mode account and uses a trial, so
 * it cannot collect a payment or touch a live customer.
 */
export async function POST(request: Request) {
  if (!isSameOrigin(request)) return NextResponse.json({ error: "Bad origin" }, { status: 403 });

  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Please sign in again." }, { status: 401 });

  const db = getDb();
  const account = await findAccountForUser(db, user.id);
  if (!account?.stripe_account_id || account.stripe_connection_status !== "connected") {
    return NextResponse.json({ error: "Connect Stripe first." }, { status: 409 });
  }
  if (account.stripe_livemode !== false) {
    return NextResponse.json({ error: "A test-mode Stripe connection is required for this beta." }, { status: 400 });
  }

  try {
    const target = await getStripeResolver(db)(account.stripe_account_id);
    const suffix = crypto.randomUUID();
    const idempotency = (part: string) => `unquit_beta_fixture_${account.id}_${suffix}_${part}`;

    const customer = await target.stripe.customers.create(
      {
        name: "Unquit Beta Test Customer",
        email: `unquit-beta-${suffix}@example.com`,
        description: "Unquit public beta fixture (test mode only)",
        metadata: { unquit_beta_fixture: "true", unquit_account_id: account.id },
      },
      { ...target.on, idempotencyKey: idempotency("customer") },
    );

    const product = await target.stripe.products.create(
      {
        name: "Unquit Beta Test Plan",
        metadata: { unquit_beta_fixture: "true", unquit_account_id: account.id },
      },
      { ...target.on, idempotencyKey: idempotency("product") },
    );

    const price = await target.stripe.prices.create(
      {
        product: product.id,
        currency: "usd",
        unit_amount: 4900,
        recurring: { interval: "month" },
        metadata: { unquit_beta_fixture: "true", unquit_account_id: account.id },
      },
      { ...target.on, idempotencyKey: idempotency("price") },
    );

    const subscription = await target.stripe.subscriptions.create(
      {
        customer: customer.id,
        items: [{ price: price.id }],
        trial_period_days: 30,
        collection_method: "send_invoice",
        days_until_due: 30,
        metadata: { unquit_beta_fixture: "true", unquit_account_id: account.id },
      },
      { ...target.on, idempotencyKey: idempotency("subscription") },
    );

    return NextResponse.json({ customerId: customer.id, subscriptionId: subscription.id });
  } catch (error) {
    console.error("[dashboard/test-fixture] Stripe fixture failed", error);
    return NextResponse.json({ error: "Stripe could not create the test fixture. Please try again." }, { status: 502 });
  }
}
