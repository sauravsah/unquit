import "server-only";
import type Stripe from "stripe";
import type { SupabaseClient } from "@supabase/supabase-js";
import { verifyPendingCancelSaves } from "@/lib/saves/verify";
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
export async function handleStripeEvent(admin: SupabaseClient, event: Stripe.Event): Promise<HandleOutcome> {
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
      return "processed";

    case "invoice.payment_failed":
      await openOrUpdateDunningCase(admin, account.id, event.data.object);
      return "processed";

    case "invoice.paid":
      await handleInvoicePaid(admin, account.id, event.data.object);
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

async function openOrUpdateDunningCase(admin: SupabaseClient, accountId: string, invoice: Stripe.Invoice): Promise<void> {
  const customerId = idOf(invoice.customer);
  if (!customerId) throw new Error(`Invoice ${invoice.id} has no customer`);

  // Insert the case once; later failures on the same invoice update it.
  // Never reopen a case that has already been recovered or closed.
  const { data: existing, error: readError } = await admin
    .from("dunning_cases")
    .select("id, status")
    .eq("account_id", accountId)
    .eq("stripe_invoice_id", invoice.id)
    .maybeSingle();
  if (readError) throw new Error(`Reading dunning case failed: ${readError.message}`);

  const fields = {
    stripe_customer_id: customerId,
    stripe_subscription_id: invoiceSubscriptionId(invoice),
    amount_due_cents: invoice.amount_remaining ?? invoice.amount_due,
    currency: invoice.currency,
    attempt_count: invoice.attempt_count,
    next_payment_attempt_at: toIso(invoice.next_payment_attempt),
    hosted_invoice_url: invoice.hosted_invoice_url ?? null,
    // TODO(week 3): fill last_failure_code / last_failure_message from the
    //               invoice's PaymentIntent `last_payment_error` (decline code).
  };

  if (!existing) {
    const { error } = await admin
      .from("dunning_cases")
      .upsert(
        { account_id: accountId, stripe_invoice_id: invoice.id, status: "open", ...fields },
        { onConflict: "account_id,stripe_invoice_id", ignoreDuplicates: true },
      );
    if (error) throw new Error(`Opening dunning case for ${invoice.id} failed: ${error.message}`);
    // TODO(week 3): schedule Unquit's smart retries and email the card-update link.
    return;
  }

  if (existing.status !== "open") return;

  const { error } = await admin.from("dunning_cases").update(fields).eq("id", existing.id);
  if (error) throw new Error(`Updating dunning case ${existing.id} failed: ${error.message}`);
}

async function handleInvoicePaid(admin: SupabaseClient, accountId: string, invoice: Stripe.Invoice): Promise<void> {
  // 1) Close any open dunning case for this invoice.
  //    Attribution (was it Unquit's retry/link, or something else?) comes in
  //    week 3. Until then we record it as 'external' so nothing is billed.
  // TODO(week 3): set recovered_via to 'unquit_retry' / 'unquit_link' when the
  //               payment came from Unquit, and create the dunning save.
  const { error: dunningError } = await admin
    .from("dunning_cases")
    .update({
      status: "recovered",
      recovered_via: "external",
      recovered_amount_cents: invoice.amount_paid,
      recovered_at: new Date().toISOString(),
    })
    .eq("account_id", accountId)
    .eq("stripe_invoice_id", invoice.id)
    .eq("status", "open");
  if (dunningError) throw new Error(`Closing dunning case for ${invoice.id} failed: ${dunningError.message}`);

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
