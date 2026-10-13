import { NextResponse } from "next/server";
import type Stripe from "stripe";
import { handlePlatformEvent } from "@/lib/billing/platform";
import { serverEnv } from "@/lib/env";
import { getStripe } from "@/lib/stripe/client";
import { getDb } from "@/lib/db";
import { claimWebhookEvent, finishWebhookEvent } from "@/lib/stripe/webhook-events";

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

  const db = getDb();
  // Same idempotency log as the Connect webhook. Every handler here is also
  // safe to repeat, so a failed event is simply re-run when Stripe retries.
  try {
    const claim = await claimWebhookEvent(db, event, { stripeAccountId: null, retryFailed: false });
    if (claim === "duplicate") return NextResponse.json({ received: true, duplicate: true });
  } catch {
    return NextResponse.json({ error: "Storage unavailable" }, { status: 500 });
  }

  try {
    const outcome = await handlePlatformEvent(db, getStripe(), event);
    await finishWebhookEvent(db, event.id, outcome);
    return NextResponse.json({ received: true, outcome });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[stripe/platform-webhook] ${event.type} ${event.id} failed: ${message}`);
    await finishWebhookEvent(db, event.id, "failed", message);
    return NextResponse.json({ error: "Processing failed" }, { status: 500 });
  }
}
