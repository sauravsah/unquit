import { NextResponse } from "next/server";
import { isSameOrigin } from "@/lib/http";
import { serverEnv } from "@/lib/env";
import { getStripe } from "@/lib/stripe/client";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

/** Disconnects the founder's Stripe account from Unquit (revokes OAuth access). */
export async function POST(request: Request) {
  if (!isSameOrigin(request)) {
    return NextResponse.json({ error: "Bad origin" }, { status: 403 });
  }

  const supabase = createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.redirect(new URL("/login", request.url), 303);

  const { data: account, error } = await supabase
    .from("accounts")
    .select("id, stripe_account_id, stripe_connection_status")
    .eq("owner_user_id", user.id)
    .maybeSingle();
  if (error) throw new Error(`Loading account failed: ${error.message}`);

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

    const admin = createSupabaseAdminClient();
    const { error: updateError } = await admin
      .from("accounts")
      .update({ stripe_connection_status: "disconnected", stripe_disconnected_at: new Date().toISOString() })
      .eq("id", account.id);
    if (updateError) throw new Error(`Disconnecting failed: ${updateError.message}`);
  }

  return NextResponse.redirect(new URL("/dashboard?stripe=disconnected", request.url), 303);
}
