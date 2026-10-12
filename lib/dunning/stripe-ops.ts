import "server-only";
import type Stripe from "stripe";
import { idOf, invoiceSubscriptionId } from "@/lib/stripe/ids";
import type { CardUpdateStripe, LiveInvoice, PayOutcome } from "./card-update";
import type { DunningStripe } from "./service";

/**
 * The real Stripe side of dunning. Every call runs ON THE FOUNDER'S connected
 * account (`stripeAccount` header) with Unquit's platform key: with Standard
 * Connect the customer, subscription and invoice all live on that account.
 */

type StripeErrorLike = {
  type?: string;
  code?: string;
  decline_code?: string;
  message?: string;
  payment_intent?: { client_secret?: string | null; status?: string } | null;
  raw?: { payment_intent?: { client_secret?: string | null; status?: string } | null };
};

function isMissing(error: unknown): boolean {
  return (error as StripeErrorLike | null)?.code === "resource_missing";
}

export function toLiveInvoice(invoice: Stripe.Invoice): LiveInvoice {
  return {
    id: invoice.id,
    status: invoice.status ?? null,
    customerId: idOf(invoice.customer),
    subscriptionId: invoiceSubscriptionId(invoice),
    amountDueCents: invoice.amount_due,
    amountRemainingCents: invoice.amount_remaining ?? invoice.amount_due,
    amountPaidCents: invoice.amount_paid,
    currency: invoice.currency,
    number: invoice.number ?? null,
    hostedInvoiceUrl: invoice.hosted_invoice_url ?? null,
    paidAtUnix: invoice.status_transitions?.paid_at ?? null,
  };
}

/** PaymentIntents behind an invoice, newest API (invoice.payments) and older ones (invoice.payment_intent). */
function invoicePaymentIntents(invoice: Stripe.Invoice): Stripe.PaymentIntent[] {
  const out: Stripe.PaymentIntent[] = [];
  for (const p of invoice.payments?.data ?? []) {
    const pi = p.payment?.payment_intent;
    if (pi && typeof pi === "object") out.push(pi);
  }
  const legacy = (invoice as unknown as { payment_intent?: Stripe.PaymentIntent | string | null }).payment_intent;
  if (legacy && typeof legacy === "object") out.push(legacy);
  return out.sort((a, b) => b.created - a.created);
}

const EXPAND_PAYMENTS = ["payments.data.payment.payment_intent"];

async function retrieveWithPayments(stripe: Stripe, stripeAccount: string, invoiceId: string): Promise<Stripe.Invoice> {
  try {
    return await stripe.invoices.retrieve(invoiceId, { expand: EXPAND_PAYMENTS }, { stripeAccount });
  } catch (error) {
    // Webhook endpoints pinned to an older API version: fall back to the legacy field.
    if ((error as StripeErrorLike).type === "StripeInvalidRequestError" && !isMissing(error)) {
      return stripe.invoices.retrieve(invoiceId, { expand: ["payment_intent"] }, { stripeAccount });
    }
    throw error;
  }
}

export type DeclineInfo = { declineCode: string | null; errorCode: string | null; message: string | null; paymentIntentId: string | null };

/** The decline behind a failed invoice: the latest PaymentIntent's last_payment_error. */
export async function lookupDecline(stripe: Stripe, stripeAccount: string, invoiceId: string): Promise<DeclineInfo> {
  const invoice = await retrieveWithPayments(stripe, stripeAccount, invoiceId);
  for (const pi of invoicePaymentIntents(invoice)) {
    const err = pi.last_payment_error;
    if (err || pi.status === "requires_action") {
      return {
        declineCode: err?.decline_code ?? null,
        errorCode: err?.code ?? (pi.status === "requires_action" ? "authentication_required" : null),
        message: err?.message ?? null,
        paymentIntentId: pi.id,
      };
    }
  }
  return { declineCode: null, errorCode: null, message: null, paymentIntentId: invoicePaymentIntents(invoice)[0]?.id ?? null };
}

export function createDunningStripe(stripe: Stripe): DunningStripe {
  return {
    async getLiveState(stripeAccount, invoiceId, subscriptionId) {
      const on = { stripeAccount };
      let invoiceStatus: string | null;
      try {
        invoiceStatus = (await stripe.invoices.retrieve(invoiceId, {}, on)).status ?? null;
      } catch (error) {
        if (!isMissing(error)) throw error;
        invoiceStatus = "deleted";
      }
      let subscriptionStatus: string | null = null;
      if (subscriptionId) {
        try {
          subscriptionStatus = (await stripe.subscriptions.retrieve(subscriptionId, {}, on)).status;
        } catch (error) {
          if (!isMissing(error)) throw error;
          subscriptionStatus = "canceled";
        }
      }
      return { invoiceStatus, subscriptionStatus };
    },
  };
}

export function createCardUpdateStripe(stripe: Stripe): CardUpdateStripe {
  async function requiresActionSecret(stripeAccount: string, invoiceId: string): Promise<string | null> {
    const invoice = await retrieveWithPayments(stripe, stripeAccount, invoiceId);
    const pi = invoicePaymentIntents(invoice).find((p) => p.status === "requires_action" || p.status === "requires_confirmation");
    return pi?.client_secret ?? null;
  }

  return {
    async getInvoice(stripeAccount, invoiceId) {
      try {
        return toLiveInvoice(await stripe.invoices.retrieve(invoiceId, {}, { stripeAccount }));
      } catch (error) {
        if (isMissing(error)) return null;
        throw error;
      }
    },

    async createSetupIntent(stripeAccount, input) {
      const si = await stripe.setupIntents.create(
        {
          customer: input.customerId,
          usage: "off_session", // future renewals charge it without the customer present
          allowed_payment_method_types: ["card"],
          metadata: { unquit_dunning_case: input.caseId },
        },
        { stripeAccount, idempotencyKey: input.idempotencyKey },
      );
      if (!si.client_secret) throw new Error("Stripe returned a SetupIntent without a client secret");
      return { id: si.id, clientSecret: si.client_secret };
    },

    async getSetupIntent(stripeAccount, setupIntentId) {
      try {
        const si = await stripe.setupIntents.retrieve(setupIntentId, {}, { stripeAccount });
        return {
          id: si.id,
          status: si.status,
          customerId: idOf(si.customer),
          paymentMethodId: idOf(si.payment_method),
          caseId: si.metadata?.unquit_dunning_case ?? null,
        };
      } catch (error) {
        if (isMissing(error)) return null;
        throw error;
      }
    },

    async setDefaultPaymentMethod(stripeAccount, input) {
      await stripe.customers.update(
        input.customerId,
        { invoice_settings: { default_payment_method: input.paymentMethodId } },
        { stripeAccount, idempotencyKey: `${input.idempotencyKey}_customer` },
      );
      if (input.subscriptionId) {
        await stripe.subscriptions.update(
          input.subscriptionId,
          { default_payment_method: input.paymentMethodId },
          { stripeAccount, idempotencyKey: `${input.idempotencyKey}_subscription` },
        );
      }
    },

    async payInvoice(stripeAccount, invoiceId, input): Promise<PayOutcome> {
      try {
        const invoice = await stripe.invoices.pay(
          invoiceId,
          {
            ...(input.paymentMethodId ? { payment_method: input.paymentMethodId } : {}),
            off_session: false, // the customer is on the page, so the bank can ask for 3DS
          },
          { stripeAccount, idempotencyKey: input.idempotencyKey },
        );
        if (invoice.status === "paid") return { status: "paid", invoice: toLiveInvoice(invoice) };
        const secret = await requiresActionSecret(stripeAccount, invoiceId);
        if (secret) return { status: "requires_action", clientSecret: secret };
        return { status: "failed", message: "The payment didn't go through. Please try again.", declineCode: null };
      } catch (error) {
        const e = error as StripeErrorLike;
        const pi = e.payment_intent ?? e.raw?.payment_intent;
        if (pi?.status === "requires_action" && pi.client_secret) return { status: "requires_action", clientSecret: pi.client_secret };
        if (e.code === "invoice_payment_intent_requires_action" || e.decline_code === "authentication_required") {
          const secret = await requiresActionSecret(stripeAccount, invoiceId);
          if (secret) return { status: "requires_action", clientSecret: secret };
        }
        if (e.type === "StripeCardError") {
          return { status: "failed", message: e.message ?? "Your card was declined.", declineCode: e.decline_code ?? e.code ?? null };
        }
        // Paid in the meantime (another tab, Smart Retries)? Then it's done.
        const now = await stripe.invoices.retrieve(invoiceId, {}, { stripeAccount }).catch(() => null);
        if (now?.status === "paid") return { status: "paid", invoice: toLiveInvoice(now) };
        if (e.type === "StripeInvalidRequestError") {
          return { status: "failed", message: "This invoice can't be paid right now.", declineCode: e.code ?? null };
        }
        throw error;
      }
    },
  };
}
