import { NextResponse } from "next/server";
import { createBillingRepo } from "@/lib/billing/repo";
import { ensurePlatformCustomer } from "@/lib/billing/service";
import { createBillingStripe, createSetupCheckout } from "@/lib/billing/stripe-ops";
import { publicEnv } from "@/lib/env";
import { isSameOrigin } from "@/lib/http";
import { getStripe } from "@/lib/stripe/client";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { createSupabaseServerClient } from "@/lib/supabase/server";

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
  const supabase = createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.redirect(new URL("/login?next=/dashboard/billing", request.url), { status: 303 });

  const { data: account, error } = await supabase.from("accounts").select("id").eq("owner_user_id", user.id).maybeSingle();
  if (error || !account) return NextResponse.redirect(new URL("/dashboard/billing?setup=error", request.url), { status: 303 });

  try {
    const admin = createSupabaseAdminClient();
    const stripe = getStripe();
    const customerId = await ensurePlatformCustomer(createBillingRepo(admin), createBillingStripe(stripe), account.id as string);
    const base = publicEnv.appUrl();
    const url = await createSetupCheckout(stripe, {
      customerId,
      accountId: account.id as string,
      successUrl: `${base}/dashboard/billing?setup=success&session_id={CHECKOUT_SESSION_ID}`,
      cancelUrl: `${base}/dashboard/billing?setup=cancelled`,
    });
    return NextResponse.redirect(url, { status: 303 });
  } catch (e) {
    console.error("[billing/setup] could not start Checkout", e);
    return NextResponse.redirect(new URL("/dashboard/billing?setup=error", request.url), { status: 303 });
  }
}
