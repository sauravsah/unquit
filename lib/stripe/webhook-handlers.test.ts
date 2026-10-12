import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const { handleStripeEvent, HANDLED_EVENTS, toFailedInvoice } = await import("./webhook-handlers");

// A Supabase client that fails the test if anything touches the database.
const untouchable = new Proxy({}, {
  get() {
    throw new Error("database should not be touched");
  },
}) as never;

describe("handleStripeEvent routing", () => {
  it("handles exactly the Connect events the README asks founders to select", () => {
    expect([...HANDLED_EVENTS].sort()).toEqual(
      [
        "account.application.deauthorized",
        "customer.subscription.created",
        "customer.subscription.deleted",
        "customer.subscription.updated",
        "invoice.paid",
        "invoice.payment_failed",
      ].sort(),
    );
  });

  it("ignores events it doesn't handle without touching the database", async () => {
    const event = { id: "evt_1", type: "charge.succeeded", account: "acct_1", data: { object: {} } };
    await expect(handleStripeEvent(untouchable, event as never)).resolves.toBe("ignored");
  });

  it("ignores platform (non-Connect) events", async () => {
    const event = { id: "evt_2", type: "invoice.paid", data: { object: {} } };
    await expect(handleStripeEvent(untouchable, event as never)).resolves.toBe("ignored");
  });
});

describe("toFailedInvoice", () => {
  const invoice = {
    id: "in_1",
    customer: "cus_1",
    parent: { subscription_details: { subscription: "sub_1" } },
    amount_due: 4_900,
    amount_remaining: 4_900,
    currency: "usd",
    attempt_count: 2,
    next_payment_attempt: 1_760_000_000,
    hosted_invoice_url: "https://invoice.stripe.com/i/1",
    customer_email: "jamie@example.com",
    customer_name: "Jamie Rivera",
    number: "ACME-0042",
  };

  it("flattens the invoice and its decline for the dunning service", () => {
    const decline = { declineCode: "insufficient_funds", errorCode: "card_declined", message: "Declined", paymentIntentId: "pi_1" };
    expect(toFailedInvoice(invoice as never, decline)).toEqual({
      id: "in_1",
      customerId: "cus_1",
      subscriptionId: "sub_1",
      amountDueCents: 4_900,
      currency: "usd",
      attemptCount: 2,
      nextPaymentAttemptAt: new Date(1_760_000_000 * 1000).toISOString(),
      hostedInvoiceUrl: "https://invoice.stripe.com/i/1",
      customerEmail: "jamie@example.com",
      customerName: "Jamie Rivera",
      number: "ACME-0042",
      declineCode: "insufficient_funds",
      errorCode: "card_declined",
      failureMessage: "Declined",
      paymentIntentId: "pi_1",
    });
  });

  it("refuses an invoice without a customer", () => {
    const decline = { declineCode: null, errorCode: null, message: null, paymentIntentId: null };
    expect(() => toFailedInvoice({ ...invoice, customer: null } as never, decline)).toThrow(/no customer/);
  });
});
