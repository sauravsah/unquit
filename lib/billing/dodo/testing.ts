/**
 * An in-memory Dodo Payments client for tests. Records every call, lets a
 * test script what the next charge does, and keeps the payments it "made"
 * so reconciliation can find them.
 */
import { DodoApiError, type DodoClient, type DodoPayment, type DodoSubscription, type Metadata } from "./client";

export type ChargeScript =
  | { kind: "ok" }
  | { kind: "api_error"; status: number; code?: string }
  /** The request times out AFTER Dodo created the payment (outcome unknown to the caller). */
  | { kind: "lost_response" }
  /** The request fails before reaching Dodo (nothing created, outcome unknown to the caller). */
  | { kind: "network_error" };

export type FakeCharge = { subscriptionId: string; amountCents: number; description: string; metadata: Metadata; paymentId: string | null };

export function fakeDodo(opts: { productId?: string } = {}) {
  const productId = opts.productId ?? "pdt_usage";
  let seq = 0;
  const checkouts: { productId: string; customer: unknown; returnUrl: string; metadata: Metadata; sessionId: string }[] = [];
  const updates: { subscriptionId: string; returnUrl: string }[] = [];
  const charges: FakeCharge[] = [];
  const payments = new Map<string, DodoPayment>();
  const subscriptions = new Map<string, DodoSubscription>();
  const paymentMethods = new Map<string, { payment_method_id: string; brand: string | null; last4: string | null }[]>();
  const script: ChargeScript[] = [];
  let concurrentCalls = 0;
  let maxConcurrent = 0;

  function payment(id: string, fields: Partial<DodoPayment>): DodoPayment {
    return {
      payment_id: id,
      status: "processing",
      subscription_id: null,
      customer_id: null,
      total_amount: null,
      currency: "USD",
      error_code: null,
      error_message: null,
      invoice_url: null,
      card_last_four: "4242",
      card_network: "VISA",
      is_update_payment_method: false,
      metadata: {},
      created_at: new Date().toISOString(),
      ...fields,
    };
  }

  const client: DodoClient = {
    environment: "test_mode",
    async createCheckoutSession(input) {
      const sessionId = `cks_${++seq}`;
      checkouts.push({ ...input, sessionId });
      return { sessionId, checkoutUrl: `https://test.checkout.dodopayments.com/session/${sessionId}` };
    },
    async getSubscription(id) {
      return subscriptions.get(id) ?? null;
    },
    async updatePaymentMethod(subscriptionId, returnUrl) {
      updates.push({ subscriptionId, returnUrl });
      return { paymentLink: `https://test.checkout.dodopayments.com/update/${subscriptionId}`, paymentId: `pay_upd_${++seq}` };
    },
    async chargeSubscription(subscriptionId, input) {
      concurrentCalls++;
      maxConcurrent = Math.max(maxConcurrent, concurrentCalls);
      try {
        await new Promise((r) => setTimeout(r, 5));
        const step = script.shift() ?? { kind: "ok" };
        if (step.kind === "api_error") {
          charges.push({ subscriptionId, ...input, paymentId: null });
          throw new DodoApiError(`Dodo charge failed (${step.status})`, step.status, step.code ?? null);
        }
        if (step.kind === "network_error") {
          charges.push({ subscriptionId, ...input, paymentId: null });
          throw new Error("fetch failed: ECONNRESET");
        }
        const paymentId = `pay_${++seq}`;
        charges.push({ subscriptionId, ...input, paymentId });
        payments.set(paymentId, payment(paymentId, { subscription_id: subscriptionId, total_amount: input.amountCents, metadata: input.metadata }));
        if (step.kind === "lost_response") throw new Error("The operation timed out");
        return { paymentId };
      } finally {
        concurrentCalls--;
      }
    },
    async getPayment(id) {
      return payments.get(id) ?? null;
    },
    async listSubscriptionPayments(subscriptionId) {
      return [...payments.values()].filter((p) => p.subscription_id === subscriptionId);
    },
    async listCustomerPaymentMethods(customerId) {
      return paymentMethods.get(customerId) ?? [];
    },
  };

  return {
    client,
    productId,
    checkouts,
    updates,
    charges,
    payments,
    subscriptions,
    paymentMethods,
    get maxConcurrent() {
      return maxConcurrent;
    },
    /** What the next charges do, in order (default: succeed). */
    next(...steps: ChargeScript[]) {
      script.push(...steps);
    },
    /** A subscription as Dodo would report it. */
    subscription(id: string, accountId: string, fields: Partial<DodoSubscription> = {}): DodoSubscription {
      const sub: DodoSubscription = {
        subscription_id: id,
        status: "active",
        product_id: productId,
        customer_id: "cus_dodo_1",
        customer_email: "founder@example.com",
        on_demand: true,
        payment_method_id: "pm_1",
        metadata: { unquit_account_id: accountId },
        ...fields,
      };
      subscriptions.set(id, sub);
      return sub;
    },
    /** Marks a payment's final outcome, as the webhook would carry it. */
    settle(paymentId: string, status: "succeeded" | "failed", fields: Partial<DodoPayment> = {}): DodoPayment {
      const p = payments.get(paymentId);
      if (!p) throw new Error(`unknown payment ${paymentId}`);
      const next = {
        ...p,
        status,
        ...(status === "succeeded" ? { invoice_url: `https://test.dodopayments.com/invoices/payments/${paymentId}` } : {}),
        ...fields,
      };
      payments.set(paymentId, next);
      return next;
    },
  };
}

export type FakeDodo = ReturnType<typeof fakeDodo>;
