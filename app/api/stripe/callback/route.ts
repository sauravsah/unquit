import { timingSafeEqual } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { getOrCreateAccount } from "@/lib/accounts";
import { createBillingRepo } from "@/lib/billing/repo";
import { ensurePlatformCustomer } from "@/lib/billing/service";
import { createBillingStripe } from "@/lib/billing/stripe-ops";
import { getStripe } from "@/lib/stripe/client";
import { OAUTH_STATE_COOKIE, OAUTH_STATE_COOKIE_PATH } from "@/lib/stripe/oauth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

function sameState(a: string | undefined | null, b: string | undefined | null): boolean {
  if (!a || !b) return false;
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/**
 * Step 2 of Stripe Connect: Stripe sends the founder back here with a
 * one-time `code`. We swap it for their Stripe account id and save it.
 */
export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const done = (status: string) => {
    const res = NextResponse.redirect(new URL(`/dashboard?stripe=${status}`, request.url));
    res.cookies.set(OAUTH_STATE_COOKIE, "", { path: OAUTH_STATE_COOKIE_PATH, maxAge: 0 });
    return res;
  };

  // Founder clicked "Cancel" on Stripe's page, or Stripe reported an error.
  if (params.get("error")) return done("denied");

  const code = params.get("code");
  if (!code || !sameState(params.get("state"), request.cookies.get(OAUTH_STATE_COOKIE)?.value)) {
    return done("invalid_state");
  }

  const supabase = createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.redirect(new URL("/login?next=/dashboard", request.url));

  const account = await getOrCreateAccount(supabase, user);

  let token;
  try {
    token = await getStripe().oauth.token({ grant_type: "authorization_code", code });
  } catch (error) {
    console.error("[stripe/callback] code exchange failed", error);
    return done("exchange_failed");
  }

  if (!token.stripe_user_id) return done("exchange_failed");

  // We do not store the access token: with Standard Connect, Unquit's platform
  // key + the `Stripe-Account` header is enough to act on the founder's account.
  const admin = createSupabaseAdminClient();
  const { error } = await admin
    .from("accounts")
    .update({
      stripe_account_id: token.stripe_user_id,
      stripe_connection_status: "connected",
      stripe_livemode: token.livemode ?? null,
      stripe_scope: token.scope ?? null,
      stripe_connected_at: new Date().toISOString(),
      stripe_disconnected_at: null,
    })
    .eq("id", account.id);

  if (error) {
    if (error.code === "23505") return done("already_connected_elsewhere");
    console.error("[stripe/callback] saving account failed", error);
    return done("save_failed");
  }

  // Week 4: the founder's Customer on unquit's OWN Stripe account, for the
  // monthly fee invoice. Best effort: billing and /dashboard/billing create
  // it later if this fails.
  try {
    await ensurePlatformCustomer(createBillingRepo(admin), createBillingStripe(getStripe()), account.id);
  } catch (customerError) {
    console.warn("[stripe/callback] creating the platform customer failed; it will be created on first bill", customerError);
  }

  return done("connected");
}
