import { NextResponse } from "next/server";
import Stripe from "stripe";
import { loadDirectWebhookAccount } from "@/lib/accounts";
import { getDb } from "@/lib/db";
import { runDunningForCase } from "@/lib/dunning/service";
import { sequenceDeps } from "@/lib/dunning/runtime";
import { sendReceiptEmails } from "@/lib/ledger/disputes";
import { ledgerDeps } from "@/lib/ledger/runtime";
import { openForAccount } from "@/lib/stripe/connection";
import { handleStripeEvent } from "@/lib/stripe/webhook-handlers";
import { claimWebhookEvent, finishWebhookEvent } from "@/lib/stripe/webhook-events";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Signature checks are pure HMAC: no API key is used, so this client never calls Stripe.
const verifier = new Stripe("sk_unused_signature_verification_only");

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Webhook for ONE founder connected with a restricted key. Unquit created this
 * endpoint on the founder's own Stripe account, so events carry no `account`
 * field: the account comes from the URL, and the signature is checked with
 * THAT endpoint's signing secret (stored encrypted). Same claim / handle /
 * finish flow as the Connect webhook.
 */
export async function POST(request: Request, { params }: { params: { id: string } }) {
  const signature = request.headers.get("stripe-signature");
  if (!signature) return NextResponse.json({ error: "Missing stripe-signature header" }, { status: 400 });
  if (!UUID.test(params.id)) return NextResponse.json({ error: "Unknown endpoint" }, { status: 404 });

  const rawBody = await request.text();
  const db = getDb();

  let account;
  try {
    account = await loadDirectWebhookAccount(db, params.id);
  } catch (error) {
    console.error("[stripe/webhook/acct] account lookup failed", error);
    return NextResponse.json({ error: "Storage unavailable" }, { status: 500 });
  }
  if (!account) return NextResponse.json({ error: "Unknown endpoint" }, { status: 404 });

  let secret: string;
  try {
    secret = openForAccount(account.stripe_webhook_secret_ciphertext, account.id, process.env.STRIPE_KEY_ENCRYPTION_KEY);
  } catch (error) {
    // Fail closed: without the encryption key nothing can be verified, so nothing is processed (Stripe retries).
    console.error("[stripe/webhook/acct] cannot read the signing secret", error instanceof Error ? error.message : error);
    return NextResponse.json({ error: "Not configured" }, { status: 500 });
  }

  let event: Stripe.Event;
  try {
    event = verifier.webhooks.constructEvent(rawBody, signature, secret);
  } catch (error) {
    console.warn("[stripe/webhook/acct] signature verification failed", error instanceof Error ? error.message : error);
    return NextResponse.json({ error: "Invalid signature" }, { status: 400 });
  }

  try {
    const claim = await claimWebhookEvent(db, event, { stripeAccountId: account.stripe_account_id, retryFailed: true });
    if (claim === "duplicate") return NextResponse.json({ received: true, duplicate: true });
  } catch (claimError) {
    console.error("[stripe/webhook/acct] could not record event", claimError);
    return NextResponse.json({ error: "Storage unavailable" }, { status: 500 });
  }

  try {
    const outcome = await handleStripeEvent(db, event, {
      directStripeAccountId: account.stripe_account_id,
      onCaseOpened: async (caseId) => {
        try {
          await runDunningForCase(sequenceDeps(db), caseId);
        } catch (error) {
          console.warn(`[stripe/webhook/acct] immediate dunning email for case ${caseId} failed; the cron will retry`, error);
        }
      },
      onInvoicePaid: async (accountId) => {
        try {
          await sendReceiptEmails(ledgerDeps(db), { accountId, limit: 20 });
        } catch (error) {
          console.warn(`[stripe/webhook/acct] receipt emails for ${accountId} failed; the cron will retry`, error);
        }
      },
    });
    await finishWebhookEvent(db, event.id, outcome);
    return NextResponse.json({ received: true, outcome });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[stripe/webhook/acct] ${event.type} ${event.id} failed: ${message}`);
    await finishWebhookEvent(db, event.id, "failed", message);
    return NextResponse.json({ error: "Processing failed" }, { status: 500 });
  }
}
