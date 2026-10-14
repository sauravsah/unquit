import { NextResponse } from "next/server";
import { dodoDeps } from "@/lib/billing/dodo/runtime";
import { claimWebhook, finishWebhook, handleDodoEvent, type DodoEvent } from "@/lib/billing/dodo/service";
import { verifyWebhook, WebhookVerificationError } from "@/lib/billing/dodo/webhook-verify";
import { serverEnv } from "@/lib/env";
import { getDb } from "@/lib/db";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Dodo Payments webhooks for unquit's OWN billing (Standard Webhooks:
 * webhook-id / webhook-timestamp / webhook-signature). Verified against
 * DODO_PAYMENTS_WEBHOOK_SECRET, then de-duplicated by webhook-id, so a
 * redelivery or a replayed request changes nothing.
 */
export async function POST(request: Request) {
  let secret: string;
  try {
    secret = serverEnv.dodoWebhookSecret();
  } catch {
    return NextResponse.json({ error: "DODO_PAYMENTS_WEBHOOK_SECRET is not set" }, { status: 503 });
  }

  const raw = await request.text();
  const headers = {
    id: request.headers.get("webhook-id"),
    timestamp: request.headers.get("webhook-timestamp"),
    signature: request.headers.get("webhook-signature"),
  };
  try {
    verifyWebhook(secret, headers, raw);
  } catch (error) {
    const reason = error instanceof WebhookVerificationError ? error.reason : "unknown";
    // Diagnostics without the secret itself: is it shaped like a Dodo signing secret?
    console.warn(`[billing/dodo/webhook] rejected (${reason}); secret looks like whsec_: ${secret.trim().startsWith("whsec_")}`);
    return NextResponse.json({ error: "Invalid signature" }, { status: reason === "bad_secret" ? 500 : 401 });
  }

  let event: DodoEvent;
  try {
    const parsed = JSON.parse(raw) as Partial<DodoEvent>;
    if (typeof parsed.type !== "string" || !parsed.data || typeof parsed.data !== "object") throw new Error("not an event");
    event = { type: parsed.type, timestamp: parsed.timestamp ?? null, business_id: parsed.business_id ?? null, data: parsed.data as Record<string, unknown> };
  } catch {
    return NextResponse.json({ error: "Bad payload" }, { status: 400 });
  }

  const db = getDb();
  const webhookId = headers.id!;
  const objectId = String(event.data.payment_id ?? event.data.subscription_id ?? event.data.refund_id ?? "") || null;
  try {
    const claim = await claimWebhook(db, webhookId, event.type, objectId, new Date());
    if (claim === "duplicate") return NextResponse.json({ received: true, duplicate: true });
    if (claim === "in_progress") return NextResponse.json({ error: "Already processing" }, { status: 409 });
  } catch (error) {
    console.error("[billing/dodo/webhook] storage unavailable", error);
    return NextResponse.json({ error: "Storage unavailable" }, { status: 500 });
  }

  try {
    const outcome = await handleDodoEvent(dodoDeps(db), event);
    await finishWebhook(db, webhookId, outcome, new Date());
    console.info(`[billing/dodo/webhook] ${event.type} ${objectId ?? ""} ${outcome}`);
    return NextResponse.json({ received: true, outcome });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[billing/dodo/webhook] ${event.type} ${webhookId} failed: ${message}`);
    await finishWebhook(db, webhookId, "failed", new Date(), message).catch(() => undefined);
    return NextResponse.json({ error: "Processing failed" }, { status: 500 });
  }
}
