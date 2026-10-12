import "server-only";
import type Stripe from "stripe";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createDunningRepo } from "@/lib/dunning/repo";
import { subscriptionEndsDunning } from "@/lib/dunning/schedule";
import { openOrUpdateCase, recordRecovery, stopForCanceledSubscription } from "@/lib/dunning/service";
import { lookupDecline, type DeclineInfo } from "@/lib/dunning/stripe-ops";
import type { FailedInvoice } from "@/lib/dunning/types";
import { verifyPendingCancelSaves } from "@/lib/saves/verify";
import { getStripe } from "./client";
import { subscriptionMrrCents, subscriptionPeriodEnd } from "./mrr";
import { idOf, invoiceSubscriptionId, toIso } from "./ids";

/** Events Unquit acts on. Everything else is acknowledged and ignored. */
export const HANDLED_EVENTS = new Set<string>([
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "invoice.payment_failed",
  "invoice.paid",
  "account.application.deauthorized",
]);

export type HandleOutcome = "processed" | "ignored";

export type HandlerDeps = {
  /** Reads the decline behind a failed invoice. Defaults to the live Stripe API. */
  lookupDecline?: (stripeAccount: string, invoiceId: string) => Promise<DeclineInfo>;
  /** Called after invoice.payment_failed OPENED a new case (the route sends the day-0 email right away). */
  onCaseOpened?: (caseId: string) => Promise<void>;
  now?: () => Date;
};

type AccountRow = { id: string; stripe_connection_status: string };

/** The Unquit account this Stripe account is currently connected to, if any. */
async function findAccount(admin: SupabaseClient, stripeAccountId: string): Promise<AccountRow | null> {
  const { data, error } = await admin
    .from("accounts")
    .select("id, stripe_connection_status")
    .eq("stripe_account_id", stripeAccountId)
    .eq("stripe_connection_status", "connected")
    .maybeSingle();
  if (error) throw new Error(`Account lookup failed: ${error.message}`);
  return data as AccountRow | null;
}

/**
 * Routes one verified Stripe Connect event to its handler.
 * Throws on unexpected failures so the caller can mark the event failed and
 * return 500 (Stripe then retries with back-off).
 */
export async function handleStripeEvent(
  admin: SupabaseClient,
  event: Stripe.Event,
  deps: HandlerDeps = {},
): Promise<HandleOutcome> {
  if (!HANDLED_EVENTS.has(event.type)) return "ignored";

  // Connect events carry the connected account id. Events without one were
  // sent for Unquit's own platform account and are not ours to process here.
  const stripeAccountId = event.account;
  if (!stripeAccountId) return "ignored";

  const account = await findAccount(admin, stripeAccountId);
  if (!account) return "ignored"; // not (or no longer) an Unquit customer

  switch (event.type) {
    case "customer.subscription.created":
    case "customer.subscription.updated":
    case "customer.subscription.deleted":
      await upsertSubscription(admin, account.id, event.data.object, event.created);
      // A cancelled subscription ends its dunning sequence right away.
      if (event.type === "customer.subscription.deleted" || subscriptionEndsDunning(event.data.object.status)) {
        await stopForCanceledSubscription(createDunningRepo(admin), account.id, event.data.object.id, deps.now?.() ?? new Date());
      }
      return "processed";

    case "invoice.payment_failed":
      await openOrUpdateDunningCase(admin, account.id, stripeAccountId, event.data.object, deps);
      return "processed";

    case "invoice.paid":
      await handleInvoicePaid(admin, account.id, event.data.object, event.created);
      return "processed";

    case "account.application.deauthorized":
      // The founder disconnected Unquit from inside their Stripe dashboard.
      await markRevoked(admin, account.id);
      return "processed";

    default:
      return "ignored";
  }
}

async function upsertSubscription(
  admin: SupabaseClient,
  accountId: string,
  subscription: Stripe.Subscription,
  eventCreatedUnix: number,
): Promise<void> {
  const customerId = idOf(subscription.customer);
  if (!customerId) throw new Error(`Subscription ${subscription.id} has no customer`);

  const { error } = await admin.rpc("upsert_subscription_cache", {
    p_account_id: accountId,
    p_stripe_subscription_id: subscription.id,
    p_stripe_customer_id: customerId,
    p_status: subscription.status,
    p_mrr_cents: subscriptionMrrCents(subscription),
    p_currency: subscription.currency ?? "usd",
    p_cancel_at_period_end: subscription.cancel_at_period_end ?? false,
    p_current_period_end: toIso(subscriptionPeriodEnd(subscription)),
    p_canceled_at: toIso(subscription.canceled_at),
    p_stripe_created_at: toIso(subscription.created),
    p_event_created_at: toIso(eventCreatedUnix),
  });
  if (error) throw new Error(`Caching subscription ${subscription.id} failed: ${error.message}`);
}

/** Flattens a Stripe invoice + its decline into what the dunning service needs. */
export function toFailedInvoice(invoice: Stripe.Invoice, decline: DeclineInfo): FailedInvoice {
  const customerId = idOf(invoice.customer);
  if (!customerId) throw new Error(`Invoice ${invoice.id} has no customer`);
  return {
    id: invoice.id,
    customerId,
    subscriptionId: invoiceSubscriptionId(invoice),
    amountDueCents: invoice.amount_remaining ?? invoice.amount_due,
    currency: invoice.currency,
    attemptCount: invoice.attempt_count,
    nextPaymentAttemptAt: toIso(invoice.next_payment_attempt),
    hostedInvoiceUrl: invoice.hosted_invoice_url ?? null,
    customerEmail: invoice.customer_email ?? null,
    customerName: invoice.customer_name ?? null,
    number: invoice.number ?? null,
    declineCode: decline.declineCode,
    errorCode: decline.errorCode,
    failureMessage: decline.message,
    paymentIntentId: decline.paymentIntentId,
  };
}

async function openOrUpdateDunningCase(
  admin: SupabaseClient,
  accountId: string,
  stripeAccountId: string,
  invoice: Stripe.Invoice,
  deps: HandlerDeps,
): Promise<void> {
  // The decline code lives on the invoice's PaymentIntent, not on the event.
  // If Stripe can't be reached, open the case anyway (treated as a hard
  // decline, which asks for a new card); a later failure fills the code in.
  const lookup = deps.lookupDecline ?? ((acct: string, id: string) => lookupDecline(getStripe(), acct, id));
  let decline: DeclineInfo = { declineCode: null, errorCode: null, message: null, paymentIntentId: null };
  try {
    decline = await lookup(stripeAccountId, invoice.id);
  } catch (error) {
    console.warn(`[stripe/webhook] decline lookup for ${invoice.id} failed`, error);
  }

  const result = await openOrUpdateCase(createDunningRepo(admin), accountId, toFailedInvoice(invoice, decline), deps.now?.() ?? new Date());
  if (result.created && result.caseId && deps.onCaseOpened) await deps.onCaseOpened(result.caseId);
}

async function handleInvoicePaid(
  admin: SupabaseClient,
  accountId: string,
  invoice: Stripe.Invoice,
  eventCreatedUnix: number,
): Promise<void> {
  // 1) Close the dunning case for this invoice, if there is one. A payment
  //    Unquit started (card-update page or "try my card again") becomes a
  //    billable dunning save; anything else is recorded as 'external' (no fee).
  await recordRecovery(createDunningRepo(admin), accountId, {
    id: invoice.id,
    amountPaidCents: invoice.amount_paid,
    paidAt: new Date((invoice.status_transitions?.paid_at ?? eventCreatedUnix) * 1000),
  });

  // 2) A paid "next invoice" is what turns a pending cancel save into a verified one.
  await verifyPendingCancelSaves(admin, accountId, {
    id: invoice.id,
    subscriptionId: invoiceSubscriptionId(invoice),
    amountPaidCents: invoice.amount_paid,
    createdUnix: invoice.created,
    billingReason: invoice.billing_reason ?? null,
  });
}

async function markRevoked(admin: SupabaseClient, accountId: string): Promise<void> {
  const { error } = await admin
    .from("accounts")
    .update({ stripe_connection_status: "revoked", stripe_disconnected_at: new Date().toISOString() })
    .eq("id", accountId);
  if (error) throw new Error(`Marking account ${accountId} revoked failed: ${error.message}`);
}
