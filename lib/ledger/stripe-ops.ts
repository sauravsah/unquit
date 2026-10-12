import "server-only";
import type Stripe from "stripe";
import { idOf, invoiceSubscriptionId } from "@/lib/stripe/ids";
import type { EvidenceStripe, InvoiceEvidence } from "./disputes";

/**
 * Stripe reads the ledger needs on a founder's CONNECTED account (always with
 * the Stripe-Account header). Charges no longer carry an `invoice` field in
 * current API versions, so a charge is matched to its invoice through the
 * Invoice Payments API (payment intent -> invoice).
 */

export async function invoiceForPaymentIntent(stripe: Stripe, stripeAccount: string, paymentIntentId: string | null): Promise<string | null> {
  if (!paymentIntentId) return null;
  const list = await stripe.invoicePayments.list(
    { payment: { type: "payment_intent", payment_intent: paymentIntentId }, limit: 1 },
    { stripeAccount },
  );
  const first = list.data[0];
  return first ? idOf(first.invoice as string | { id: string }) : null;
}

export async function invoiceForCharge(stripe: Stripe, stripeAccount: string, chargeId: string): Promise<string | null> {
  const charge = await stripe.charges.retrieve(chargeId, {}, { stripeAccount });
  return invoiceForPaymentIntent(stripe, stripeAccount, idOf(charge.payment_intent));
}

export async function invoiceAmountPaid(stripe: Stripe, stripeAccount: string, invoiceId: string): Promise<number | null> {
  const invoice = await stripe.invoices.retrieve(invoiceId, {}, { stripeAccount });
  return typeof invoice.amount_paid === "number" ? invoice.amount_paid : null;
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { statusCode?: number }).statusCode === 404;
}

/** The evidence checks behind a founder's dispute (lib/ledger/disputes.ts). */
export function createEvidenceStripe(stripe: Stripe): EvidenceStripe {
  return {
    async getInvoiceEvidence(stripeAccount, invoiceId): Promise<InvoiceEvidence | null> {
      let invoice: Stripe.Invoice;
      try {
        invoice = await stripe.invoices.retrieve(invoiceId, {}, { stripeAccount });
      } catch (error) {
        if (isMissing(error)) return null;
        throw error;
      }
      // Only "was anything returned?" matters here, so a credit note's refund
      // being counted on both sides is harmless.
      let refunded = Number(invoice.post_payment_credit_notes_amount ?? 0);
      const payments = await stripe.invoicePayments.list(
        { invoice: invoiceId, limit: 10, expand: ["data.payment.payment_intent.latest_charge"] },
        { stripeAccount },
      );
      for (const p of payments.data) {
        const pi = p.payment.payment_intent;
        const charge = pi && typeof pi !== "string" ? pi.latest_charge : null;
        if (charge && typeof charge !== "string") refunded += Number(charge.amount_refunded ?? 0);
      }
      return {
        id: invoice.id,
        status: invoice.status ?? null,
        amountPaidCents: invoice.amount_paid,
        subscriptionId: invoiceSubscriptionId(invoice),
        customerId: idOf(invoice.customer as string | { id: string } | null),
        refundedCents: refunded,
      };
    },
  };
}
