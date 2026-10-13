import { NextResponse } from "next/server";
import type Stripe from "stripe";
import { runDunningForCase } from "@/lib/dunning/service";
import { sequenceDeps } from "@/lib/dunning/runtime";
import { serverEnv } from "@/lib/env";
import { sendReceiptEmails } from "@/lib/ledger/disputes";
import { ledgerDeps } from "@/lib/ledger/runtime";
import { getStripe } from "@/lib/stripe/client";
import { handleStripeEvent } from "@/lib/stripe/webhook-handlers";
import { getDb } from "@/lib/db";
import { claimWebhookEvent, finishWebhookEvent } from "@/lib/stripe/webhook-events";

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

  const db = getDb();

  // --- Idempotency: claim the event -----------------------------------------
  try {
    const claim = await claimWebhookEvent(db, event, { stripeAccountId: event.account ?? null, retryFailed: true });
    if (claim === "duplicate") return NextResponse.json({ received: true, duplicate: true });
  } catch (claimError) {
    console.error("[stripe/webhook] could not record event", claimError);
    return NextResponse.json({ error: "Storage unavailable" }, { status: 500 });
  }

  // --- Handle ----------------------------------------------------------------
  try {
    const outcome = await handleStripeEvent(db, event, {
      // A new failed payment: send the day-0 email now rather than at the next
      // daily cron run. Best effort; the cron picks it up if this fails.
      onCaseOpened: async (caseId) => {
        try {
          await runDunningForCase(sequenceDeps(db), caseId);
        } catch (error) {
          console.warn(`[stripe/webhook] immediate dunning email for case ${caseId} failed; the cron will retry`, error);
        }
      },
      // A paid invoice may have verified a save (cancel or dunning): email its
      // receipt now. Best effort; the daily cron sends any that fail.
      onInvoicePaid: async (accountId) => {
        try {
          await sendReceiptEmails(ledgerDeps(db), { accountId, limit: 20 });
        } catch (error) {
          console.warn(`[stripe/webhook] receipt emails for ${accountId} failed; the cron will retry`, error);
        }
      },
    });
    await finishWebhookEvent(db, event.id, outcome);
    return NextResponse.json({ received: true, outcome });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[stripe/webhook] ${event.type} ${event.id} failed: ${message}`);
    await finishWebhookEvent(db, event.id, "failed", message);
    return NextResponse.json({ error: "Processing failed" }, { status: 500 });
  }
}
