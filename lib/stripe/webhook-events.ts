import "server-only";
import type Stripe from "stripe";
import { queryOne, type Db } from "@/lib/db/core";

/**
 * The webhook idempotency log (`webhook_events`): Stripe can deliver an event
 * more than once; each event id is processed once (a failed one is retried).
 */

export type ClaimResult = "claimed" | "duplicate";

/**
 * Claims the event id. "duplicate" when it was already seen and isn't a
 * failed attempt we may retry (with `retryFailed`). Throws when the log is
 * unavailable, so the route can answer 500 and Stripe retries.
 */
export async function claimWebhookEvent(
  db: Db,
  event: Stripe.Event,
  opts: { stripeAccountId: string | null; retryFailed: boolean },
): Promise<ClaimResult> {
  const inserted = await db.query<{ stripe_event_id: string }>(
    `insert into webhook_events (stripe_event_id, type, stripe_account_id, livemode, event_created_at, status)
     values ($1, $2, $3, $4, $5, 'processing')
     on conflict (stripe_event_id) do nothing
     returning stripe_event_id`,
    [event.id, event.type, opts.stripeAccountId, event.livemode, new Date(event.created * 1000).toISOString()],
  );
  if (inserted.length > 0) return "claimed";

  // Seen before. Skip if it finished; retry if a previous attempt failed.
  const previous = await queryOne<{ status: string }>(db, "select status from webhook_events where stripe_event_id = $1", [event.id]);
  if (previous && previous.status !== "failed") return "duplicate";
  if (!opts.retryFailed) return "claimed";

  // Compare-and-set so two concurrent retries cannot both re-run it.
  const reclaimed = await db.query(
    `update webhook_events set status = 'processing', attempts = attempts + 1, error = null
      where stripe_event_id = $1 and status = 'failed'
      returning stripe_event_id`,
    [event.id],
  );
  return reclaimed.length > 0 ? "claimed" : "duplicate";
}

/** Records how processing ended. Best effort: never throws. */
export async function finishWebhookEvent(db: Db, eventId: string, outcome: string, error?: string): Promise<void> {
  try {
    if (outcome === "failed") {
      await db.query("update webhook_events set status = 'failed', error = $2 where stripe_event_id = $1", [eventId, (error ?? "").slice(0, 2000)]);
    } else {
      await db.query("update webhook_events set status = $2, processed_at = now(), error = null where stripe_event_id = $1", [eventId, outcome]);
    }
  } catch (e) {
    console.error(`[webhook] recording ${eventId} as ${outcome} failed`, e instanceof Error ? e.message : e);
  }
}
