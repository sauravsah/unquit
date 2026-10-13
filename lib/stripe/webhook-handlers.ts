import "server-only";
import type Stripe from "stripe";
import { attempt, queryOne, type Db } from "@/lib/db/core";
import { createDunningRepo } from "@/lib/dunning/repo";
import { subscriptionEndsDunning } from "@/lib/dunning/schedule";
import { openOrUpdateCase, recordRecovery, stopForCanceledSubscription } from "@/lib/dunning/service";
import { lookupDecline, type DeclineInfo } from "@/lib/dunning/stripe-ops";
import type { FailedInvoice } from "@/lib/dunning/types";
import { applyInvoiceReversal, creditNoteNonRefundCents, handleStripeDispute } from "@/lib/ledger/clawbacks";
import { createLedgerRepo } from "@/lib/ledger/repo";
import { invoiceAmountPaid, invoiceForCharge, invoiceForPaymentIntent } from "@/lib/ledger/stripe-ops";
import type { LedgerRepo } from "@/lib/ledger/types";
import { endSavesForSubscription, processPaidInvoice } from "@/lib/saves/verify";
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
  // Week 4: clawbacks and holds on fees earned by an invoice.
  "charge.refunded",
  "credit_note.created",
  "credit_note.updated",
  "credit_note.voided",
  "charge.dispute.created",
  "charge.dispute.updated",
  "charge.dispute.closed",
]);

export type HandleOutcome = "processed" | "ignored";

export type HandlerDeps = {
  /** Reads the decline behind a failed invoice. Defaults to the live Stripe API. */
  lookupDecline?: (stripeAccount: string, invoiceId: string) => Promise<DeclineInfo>;
  /** Called after invoice.payment_failed OPENED a new case (the route sends the day-0 email right away). */
  onCaseOpened?: (caseId: string) => Promise<void>;
  /** Called after invoice.paid (the route emails receipts for newly verified saves). */
  onInvoicePaid?: (accountId: string) => Promise<void>;
  /** The invoice a charge / payment intent paid (Invoice Payments API). Defaults to live Stripe. */
  invoiceForPayment?: (stripeAccount: string, ref: { chargeId?: string | null; paymentIntentId?: string | null }) => Promise<string | null>;
  /** What an invoice paid, when a fee line doesn't know. Defaults to live Stripe. */
  invoiceAmountPaid?: (stripeAccount: string, invoiceId: string) => Promise<number | null>;
  /** Overridable for tests. */
  ledgerRepo?: (db: Db) => LedgerRepo;
  now?: () => Date;
};

type AccountRow = { id: string; stripe_connection_status: string };

/** The Unquit account this Stripe account is currently connected to, if any. */
async function findAccount(db: Db, stripeAccountId: string): Promise<AccountRow | null> {
  return attempt("Account lookup", () =>
    queryOne<AccountRow>(
      db,
      "select id, stripe_connection_status from accounts where stripe_account_id = $1 and stripe_connection_status = 'connected'",
      [stripeAccountId],
    ),
  );
}

/**
 * Routes one verified Stripe Connect event to its handler.
 * Throws on unexpected failures so the caller can mark the event failed and
 * return 500 (Stripe then retries with back-off).
 */
export async function handleStripeEvent(
  db: Db,
  event: Stripe.Event,
  deps: HandlerDeps = {},
): Promise<HandleOutcome> {
  if (!HANDLED_EVENTS.has(event.type)) return "ignored";

  // Connect events carry the connected account id. Events without one were
  // sent for Unquit's own platform account and are not ours to process here.
  const stripeAccountId = event.account;
  if (!stripeAccountId) return "ignored";

  const account = await findAccount(db, stripeAccountId);
  if (!account) return "ignored"; // not (or no longer) an Unquit customer

  switch (event.type) {
    case "customer.subscription.created":
    case "customer.subscription.updated":
    case "customer.subscription.deleted":
      await upsertSubscription(db, account.id, event.data.object, event.created);
      // A cancelled subscription ends its dunning sequence right away...
      if (event.type === "customer.subscription.deleted" || subscriptionEndsDunning(event.data.object.status)) {
        const now = deps.now?.() ?? new Date();
        await stopForCanceledSubscription(createDunningRepo(db), account.id, event.data.object.id, now);
        // ...and its cancel saves: pending ones are lost, verified ones stop earning.
        await endSavesForSubscription(ledger(db, deps), account.id, event.data.object.id, now);
      }
      return "processed";

    case "invoice.payment_failed":
      await openOrUpdateDunningCase(db, account.id, stripeAccountId, event.data.object, deps);
      return "processed";

    case "invoice.paid":
      await handleInvoicePaid(db, account.id, event.data.object, event.created, deps);
      if (deps.onInvoicePaid) await deps.onInvoicePaid(account.id);
      return "processed";

    case "charge.refunded":
      return handleChargeRefunded(db, account.id, stripeAccountId, event.data.object, deps);

    case "credit_note.created":
    case "credit_note.updated":
    case "credit_note.voided":
      return handleCreditNote(db, account.id, stripeAccountId, event.data.object, deps);

    case "charge.dispute.created":
    case "charge.dispute.updated":
    case "charge.dispute.closed":
      return handleDispute(db, account.id, stripeAccountId, event.data.object, deps);

    case "account.application.deauthorized":
      // The founder disconnected Unquit from inside their Stripe dashboard.
      await markRevoked(db, account.id);
      return "processed";

    default:
      return "ignored";
  }
}

async function upsertSubscription(
  db: Db,
  accountId: string,
  subscription: Stripe.Subscription,
  eventCreatedUnix: number,
): Promise<void> {
  const customerId = idOf(subscription.customer);
  if (!customerId) throw new Error(`Subscription ${subscription.id} has no customer`);

  // Out-of-order (older) events are ignored by the function (migration 0001).
  await attempt(`Caching subscription ${subscription.id}`, () =>
    db.query(
      `select upsert_subscription_cache(
         $1::uuid, $2::text, $3::text, $4::text, $5::bigint, $6::text, $7::boolean,
         $8::timestamptz, $9::timestamptz, $10::timestamptz, $11::timestamptz)`,
      [
        accountId,
        subscription.id,
        customerId,
        subscription.status,
        subscriptionMrrCents(subscription),
        subscription.currency ?? "usd",
        subscription.cancel_at_period_end ?? false,
        toIso(subscriptionPeriodEnd(subscription)),
        toIso(subscription.canceled_at),
        toIso(subscription.created),
        toIso(eventCreatedUnix),
      ],
    ),
  );
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
  db: Db,
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

  const result = await openOrUpdateCase(createDunningRepo(db), accountId, toFailedInvoice(invoice, decline), deps.now?.() ?? new Date());
  if (result.created && result.caseId && deps.onCaseOpened) await deps.onCaseOpened(result.caseId);
}

function ledger(db: Db, deps: HandlerDeps): LedgerRepo {
  return (deps.ledgerRepo ?? createLedgerRepo)(db);
}

async function handleInvoicePaid(
  db: Db,
  accountId: string,
  invoice: Stripe.Invoice,
  eventCreatedUnix: number,
  deps: HandlerDeps,
): Promise<void> {
  // 1) Close the dunning case for this invoice, if there is one. A payment
  //    Unquit started (card-update page or "try my card again") becomes a
  //    billable dunning save; anything else is recorded as 'external' (no fee).
  await recordRecovery(createDunningRepo(db), accountId, {
    id: invoice.id,
    amountPaidCents: invoice.amount_paid,
    paidAt: new Date((invoice.status_transitions?.paid_at ?? eventCreatedUnix) * 1000),
  });

  // 2) A paid "next invoice" turns a pending cancel save into a verified one
  //    (fee month 1); later paid invoices add months 2 and 3.
  const paidAtUnix = invoice.status_transitions?.paid_at ?? eventCreatedUnix;
  await processPaidInvoice(
    ledger(db, deps),
    accountId,
    {
      id: invoice.id,
      subscriptionId: invoiceSubscriptionId(invoice),
      amountPaidCents: invoice.amount_paid,
      createdUnix: invoice.created,
      billingReason: invoice.billing_reason ?? null,
      customerEmail: invoice.customer_email ?? null,
      paidAt: new Date(paidAtUnix * 1000),
    },
    deps.now?.() ?? new Date(),
  );
}

// -----------------------------------------------------------------------------
// Week 4: clawbacks and holds
// -----------------------------------------------------------------------------

function paymentLookup(deps: HandlerDeps) {
  return (
    deps.invoiceForPayment ??
    (async (acct: string, ref: { chargeId?: string | null; paymentIntentId?: string | null }) => {
      if (ref.paymentIntentId) return invoiceForPaymentIntent(getStripe(), acct, ref.paymentIntentId);
      if (ref.chargeId) return invoiceForCharge(getStripe(), acct, ref.chargeId);
      return null;
    })
  );
}

function paidLookup(deps: HandlerDeps, stripeAccountId: string, invoiceId: string) {
  const lookup = deps.invoiceAmountPaid ?? ((acct: string, id: string) => invoiceAmountPaid(getStripe(), acct, id));
  return () => lookup(stripeAccountId, invoiceId);
}

/** charge.refunded: claw back pro-rata to the charge's cumulative refunds. */
async function handleChargeRefunded(
  db: Db,
  accountId: string,
  stripeAccountId: string,
  charge: Stripe.Charge,
  deps: HandlerDeps,
): Promise<HandleOutcome> {
  const invoiceId = await paymentLookup(deps)(stripeAccountId, { chargeId: charge.id, paymentIntentId: idOf(charge.payment_intent) });
  if (!invoiceId) return "ignored"; // not an invoice payment
  const result = await applyInvoiceReversal(
    ledger(db, deps),
    accountId,
    {
      invoiceId,
      sourceKey: `charge:${charge.id}`,
      kind: "refund",
      amountCents: charge.amount_refunded,
      paidCentsHint: charge.amount_captured || charge.amount,
    },
    deps.now?.() ?? new Date(),
    paidLookup(deps, stripeAccountId, invoiceId),
  );
  return result.matched ? "processed" : "ignored";
}

/** Credit notes: only the non-refund part (refunds arrive as charge.refunded). */
async function handleCreditNote(
  db: Db,
  accountId: string,
  stripeAccountId: string,
  note: Stripe.CreditNote,
  deps: HandlerDeps,
): Promise<HandleOutcome> {
  const invoiceId = idOf(note.invoice as string | { id: string });
  if (!invoiceId) return "ignored";
  const result = await applyInvoiceReversal(
    ledger(db, deps),
    accountId,
    {
      invoiceId,
      sourceKey: `credit_note:${note.id}`,
      kind: "credit_note",
      amountCents: creditNoteNonRefundCents(note),
    },
    deps.now?.() ?? new Date(),
    paidLookup(deps, stripeAccountId, invoiceId),
  );
  return result.matched ? "processed" : "ignored";
}

/** charge.dispute.*: hold while open, reverse if lost, release if won. */
async function handleDispute(
  db: Db,
  accountId: string,
  stripeAccountId: string,
  dispute: Stripe.Dispute,
  deps: HandlerDeps,
): Promise<HandleOutcome> {
  const invoiceId = await paymentLookup(deps)(stripeAccountId, {
    chargeId: idOf(dispute.charge),
    paymentIntentId: idOf(dispute.payment_intent),
  });
  if (!invoiceId) return "ignored";
  const outcome = await handleStripeDispute(
    ledger(db, deps),
    accountId,
    { disputeId: dispute.id, invoiceId, status: dispute.status, amountCents: dispute.amount },
    deps.now?.() ?? new Date(),
    paidLookup(deps, stripeAccountId, invoiceId),
  );
  return outcome === "unmatched" || outcome === "ignored" ? "ignored" : "processed";
}

async function markRevoked(db: Db, accountId: string): Promise<void> {
  await attempt(`Marking account ${accountId} revoked`, () =>
    db.query("update accounts set stripe_connection_status = 'revoked', stripe_disconnected_at = $2 where id = $1", [
      accountId,
      new Date().toISOString(),
    ]),
  );
}
