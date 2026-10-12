import "server-only";
import type Stripe from "stripe";
import { idOf } from "@/lib/stripe/ids";
import type { BillingStripe, InvoiceSummary } from "./service";

/**
 * unquit's own billing, on the PLATFORM Stripe account: these calls never
 * pass a Stripe-Account header.
 *
 * Plain Invoices + Invoice Items (not metered prices / Billing Meters): one
 * invoice a month whose lines are computed by unquit from its own ledger.
 * See "Why plain invoices" in the README.
 */
export const INVOICE_DAYS_UNTIL_DUE = 14;

function summary(invoice: Stripe.Invoice): InvoiceSummary {
  return {
    id: invoice.id,
    status: invoice.status ?? null,
    hostedInvoiceUrl: invoice.hosted_invoice_url ?? null,
    invoicePdf: invoice.invoice_pdf ?? null,
    totalCents: invoice.total,
  };
}

export function createBillingStripe(stripe: Stripe): BillingStripe {
  return {
    async createCustomer(input, idempotencyKey) {
      const customer = await stripe.customers.create(
        {
          email: input.email ?? undefined,
          name: input.name && !input.name.includes("@") ? input.name : undefined,
          description: "unquit founder account",
          metadata: { unquit_account_id: input.accountId },
        },
        { idempotencyKey },
      );
      return customer.id;
    },

    async createInvoice(input, idempotencyKey) {
      const invoice = await stripe.invoices.create(
        {
          customer: input.customerId,
          collection_method: input.collection,
          ...(input.collection === "send_invoice" ? { days_until_due: INVOICE_DAYS_UNTIL_DUE } : {}),
          currency: "usd",
          // Only the items unquit adds below, never stray pending items.
          pending_invoice_items_behavior: "exclude",
          // unquit finalizes it explicitly once every item is on it.
          auto_advance: false,
          description: input.description.slice(0, 1500),
          footer: input.footer.slice(0, 5000),
          metadata: input.metadata,
        },
        { idempotencyKey },
      );
      return { id: invoice.id };
    },

    async addInvoiceItem(input, idempotencyKey) {
      await stripe.invoiceItems.create(
        {
          customer: input.customerId,
          invoice: input.invoiceId,
          amount: input.amountCents,
          currency: "usd",
          description: input.description.slice(0, 500),
          metadata: input.metadata,
        },
        { idempotencyKey },
      );
    },

    async finalizeInvoice(invoiceId, idempotencyKey) {
      // auto_advance: Stripe now charges the saved card, or emails the invoice
      // (send_invoice) with its hosted payment page.
      const invoice = await stripe.invoices.finalizeInvoice(invoiceId, { auto_advance: true }, { idempotencyKey });
      return summary(invoice);
    },

    async getInvoice(invoiceId) {
      try {
        return summary(await stripe.invoices.retrieve(invoiceId));
      } catch (error) {
        if ((error as { statusCode?: number }).statusCode === 404) return null;
        throw error;
      }
    },

    async deleteDraftInvoice(invoiceId) {
      await stripe.invoices.del(invoiceId);
    },
  };
}

// -----------------------------------------------------------------------------
// Payment method: Stripe Checkout in setup mode
// -----------------------------------------------------------------------------

export async function createSetupCheckout(
  stripe: Stripe,
  input: { customerId: string; accountId: string; successUrl: string; cancelUrl: string },
): Promise<string> {
  const session = await stripe.checkout.sessions.create({
    mode: "setup",
    customer: input.customerId,
    currency: "usd",
    client_reference_id: input.accountId,
    metadata: { unquit_account_id: input.accountId },
    setup_intent_data: { metadata: { unquit_account_id: input.accountId } },
    success_url: input.successUrl,
    cancel_url: input.cancelUrl,
  });
  if (!session.url) throw new Error("Stripe did not return a Checkout URL");
  return session.url;
}

export type SavedPaymentMethod = { customerId: string; paymentMethodId: string; brand: string | null; last4: string | null };

/**
 * After Checkout: make the new card the customer's default for invoices.
 * Returns null unless the session is a completed setup session for exactly
 * this customer (so a session id from another founder can't be replayed).
 */
export async function completeSetupCheckout(stripe: Stripe, sessionId: string, expectedCustomerId: string): Promise<SavedPaymentMethod | null> {
  const session = await stripe.checkout.sessions.retrieve(sessionId, { expand: ["setup_intent.payment_method"] });
  if (session.mode !== "setup" || session.status !== "complete") return null;
  if (idOf(session.customer as string | { id: string } | null) !== expectedCustomerId) return null;
  const setupIntent = session.setup_intent;
  if (!setupIntent || typeof setupIntent === "string" || setupIntent.status !== "succeeded") return null;
  const pm = setupIntent.payment_method;
  if (!pm) return null;
  const paymentMethodId = typeof pm === "string" ? pm : pm.id;
  await stripe.customers.update(expectedCustomerId, { invoice_settings: { default_payment_method: paymentMethodId } });
  const card = typeof pm === "string" ? null : pm.card;
  return { customerId: expectedCustomerId, paymentMethodId, brand: card?.brand ?? null, last4: card?.last4 ?? null };
}
