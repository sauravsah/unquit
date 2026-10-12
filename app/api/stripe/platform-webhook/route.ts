import { NextResponse } from "next/server";
import type Stripe from "stripe";
import { handlePlatformEvent } from "@/lib/billing/platform";
import { serverEnv } from "@/lib/env";
import { getStripe } from "@/lib/stripe/client";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * OPTIONAL second Stripe webhook, for events on unquit's OWN account (not
 * founders' connected accounts): a founder saved a card in Checkout, or one
 * of unquit's monthly invoices was paid / failed / voided. It has its own
 * signing secret (STRIPE_PLATFORM_WEBHOOK_SECRET). Without it everything
 * still works: the Checkout return page saves the card, and the billing page
 * reads invoice status from Stripe.
 */
export async function POST(request: Request) {
  const secret = serverEnv.stripePlatformWebhookSecret();
  if (!secret) return NextResponse.json({ error: "STRIPE_PLATFORM_WEBHOOK_SECRET is not set" }, { status: 503 });
  const signature = request.headers.get("stripe-signature");
  if (!signature) return NextResponse.json({ error: "Missing stripe-signature header" }, { status: 400 });

  const rawBody = await request.text();
  let event: Stripe.Event;
  try {
    event = getStripe().webhooks.constructEvent(rawBody, signature, secret);
  } catch (error) {
    console.warn("[stripe/platform-webhook] signature verification failed", error);
    return NextResponse.json({ error: "Invalid signature" }, { status: 400 });
  }

  const admin = createSupabaseAdminClient();
  // Same idempotency log as the Connect webhook. Every handler here is also
  // safe to repeat, so a failed event is simply re-run when Stripe retries.
  const { data: claimed, error: claimError } = await admin
    .from("webhook_events")
    .upsert(
      {
        stripe_event_id: event.id,
        type: event.type,
        stripe_account_id: null,
        livemode: event.livemode,
        event_created_at: new Date(event.created * 1000).toISOString(),
        status: "processing",
      },
      { onConflict: "stripe_event_id", ignoreDuplicates: true },
    )
    .select("stripe_event_id");
  if (claimError) return NextResponse.json({ error: "Storage unavailable" }, { status: 500 });
  if (!claimed || claimed.length === 0) {
    const { data: previous } = await admin.from("webhook_events").select("status").eq("stripe_event_id", event.id).maybeSingle();
    if (previous && previous.status !== "failed") return NextResponse.json({ received: true, duplicate: true });
  }

  try {
    const outcome = await handlePlatformEvent(admin, getStripe(), event);
    await admin.from("webhook_events").update({ status: outcome, processed_at: new Date().toISOString(), error: null }).eq("stripe_event_id", event.id);
    return NextResponse.json({ received: true, outcome });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[stripe/platform-webhook] ${event.type} ${event.id} failed: ${message}`);
    await admin.from("webhook_events").update({ status: "failed", error: message.slice(0, 2000) }).eq("stripe_event_id", event.id);
    return NextResponse.json({ error: "Processing failed" }, { status: 500 });
  }
}
