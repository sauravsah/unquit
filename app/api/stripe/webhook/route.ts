import { NextResponse } from "next/server";
import type Stripe from "stripe";
import { runDunningForCase } from "@/lib/dunning/service";
import { sequenceDeps } from "@/lib/dunning/runtime";
import { serverEnv } from "@/lib/env";
import { getStripe } from "@/lib/stripe/client";
import { handleStripeEvent } from "@/lib/stripe/webhook-handlers";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Stripe Connect webhook.
 *
 * 1. Verify the signature against the RAW body (rejects forged requests).
 * 2. Claim the event id in `webhook_events` (idempotency: each event once).
 * 3. Handle it, then mark it processed / ignored / failed.
 *
 * Returning 500 on failure makes Stripe retry later; returning 200 for
 * duplicates stops Stripe from retrying something we already did.
 */
export async function POST(request: Request) {
  const signature = request.headers.get("stripe-signature");
  if (!signature) return NextResponse.json({ error: "Missing stripe-signature header" }, { status: 400 });

  const rawBody = await request.text();

  let event: Stripe.Event;
  try {
    event = getStripe().webhooks.constructEvent(rawBody, signature, serverEnv.stripeWebhookSecret());
  } catch (error) {
    console.warn("[stripe/webhook] signature verification failed", error);
    return NextResponse.json({ error: "Invalid signature" }, { status: 400 });
  }

  const admin = createSupabaseAdminClient();

  // --- Idempotency: claim the event -----------------------------------------
  const { data: claimed, error: claimError } = await admin
    .from("webhook_events")
    .upsert(
      {
        stripe_event_id: event.id,
        type: event.type,
        stripe_account_id: event.account ?? null,
        livemode: event.livemode,
        event_created_at: new Date(event.created * 1000).toISOString(),
        status: "processing",
      },
      { onConflict: "stripe_event_id", ignoreDuplicates: true },
    )
    .select("stripe_event_id");

  if (claimError) {
    console.error("[stripe/webhook] could not record event", claimError);
    return NextResponse.json({ error: "Storage unavailable" }, { status: 500 });
  }

  if (!claimed || claimed.length === 0) {
    // Seen before. Skip if it finished; retry if a previous attempt failed.
    const { data: previous } = await admin
      .from("webhook_events")
      .select("status, attempts")
      .eq("stripe_event_id", event.id)
      .maybeSingle();

    if (previous && previous.status !== "failed") {
      return NextResponse.json({ received: true, duplicate: true });
    }
    // Compare-and-set so two concurrent retries cannot both re-run it.
    const { data: reclaimed } = await admin
      .from("webhook_events")
      .update({ status: "processing", attempts: (previous?.attempts ?? 1) + 1, error: null })
      .eq("stripe_event_id", event.id)
      .eq("status", "failed")
      .select("stripe_event_id");
    if (!reclaimed || reclaimed.length === 0) {
      return NextResponse.json({ received: true, duplicate: true });
    }
  }

  // --- Handle ----------------------------------------------------------------
  try {
    const outcome = await handleStripeEvent(admin, event, {
      // A new failed payment: send the day-0 email now rather than at the next
      // daily cron run. Best effort; the cron picks it up if this fails.
      onCaseOpened: async (caseId) => {
        try {
          await runDunningForCase(sequenceDeps(admin), caseId);
        } catch (error) {
          console.warn(`[stripe/webhook] immediate dunning email for case ${caseId} failed; the cron will retry`, error);
        }
      },
    });
    await admin
      .from("webhook_events")
      .update({ status: outcome, processed_at: new Date().toISOString() })
      .eq("stripe_event_id", event.id);
    return NextResponse.json({ received: true, outcome });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[stripe/webhook] ${event.type} ${event.id} failed: ${message}`);
    await admin
      .from("webhook_events")
      .update({ status: "failed", error: message.slice(0, 2000) })
      .eq("stripe_event_id", event.id);
    return NextResponse.json({ error: "Processing failed" }, { status: 500 });
  }
}
