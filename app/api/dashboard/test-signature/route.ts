import { NextResponse } from "next/server";
import { getWidgetKeys } from "@/lib/accounts";
import { isSameOrigin } from "@/lib/http";
import { getStripe } from "@/lib/stripe/client";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { signCustomer } from "@/lib/widget/hmac";
import { createStripeOps } from "@/lib/widget/stripe-ops";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const ID = /^[A-Za-z0-9_]{3,255}$/;

/**
 * For /dashboard/test only: signs a TEST-MODE customer + subscription the
 * founder typed in, exactly like their own backend would, so they can try
 * the real widget against the real API. Refuses live-mode subscriptions so a
 * test can never discount or cancel a paying customer.
 */
export async function POST(request: Request) {
  if (!isSameOrigin(request)) return NextResponse.json({ error: "Bad origin" }, { status: 403 });

  const supabase = createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Please sign in again." }, { status: 401 });

  const body = (await request.json().catch(() => ({}))) as { customerId?: unknown; subscriptionId?: unknown };
  const customerId = typeof body.customerId === "string" ? body.customerId.trim() : "";
  const subscriptionId = typeof body.subscriptionId === "string" ? body.subscriptionId.trim() : "";
  if (!ID.test(customerId) || !customerId.startsWith("cus_")) {
    return NextResponse.json({ error: "Enter a customer id that starts with cus_." }, { status: 400 });
  }
  if (!ID.test(subscriptionId) || !subscriptionId.startsWith("sub_")) {
    return NextResponse.json({ error: "Enter a subscription id that starts with sub_." }, { status: 400 });
  }

  const { data: account, error } = await supabase
    .from("accounts")
    .select("id, stripe_account_id, stripe_connection_status")
    .eq("owner_user_id", user.id)
    .maybeSingle();
  if (error) throw new Error(`Loading account failed: ${error.message}`);
  if (!account?.stripe_account_id || account.stripe_connection_status !== "connected") {
    return NextResponse.json({ error: "Connect Stripe first." }, { status: 409 });
  }

  let sub;
  try {
    sub = await createStripeOps(getStripe(), account.stripe_account_id).getSubscription(subscriptionId);
  } catch (err) {
    console.error("[dashboard/test-signature] Stripe lookup failed", err);
    return NextResponse.json({ error: "Stripe didn't answer. Please try again." }, { status: 502 });
  }
  if (!sub || sub.customerId !== customerId) {
    return NextResponse.json(
      { error: "That subscription wasn't found for that customer in your connected Stripe account." },
      { status: 404 },
    );
  }
  if (sub.livemode) {
    return NextResponse.json(
      { error: "That's a live-mode subscription. Use a test-mode customer so no real customer is changed." },
      { status: 400 },
    );
  }

  const keys = await getWidgetKeys(supabase, account.id);
  return NextResponse.json({
    publishableKey: keys.widget_publishable_key,
    hmac: signCustomer(keys.widget_signing_secret, customerId, subscriptionId),
  });
}
