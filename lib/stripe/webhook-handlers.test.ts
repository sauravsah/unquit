import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const { handleStripeEvent, HANDLED_EVENTS, toFailedInvoice } = await import("./webhook-handlers");
const { fakeLedger } = await import("@/lib/ledger/testing/fakes");

/**
 * A Supabase stand-in for routing tests: `accounts` resolves to one connected
 * founder; every other query finds nothing. The ledger itself is the fake.
 */
function stubAdmin() {
  const builder = (table: string): unknown => {
    const result = { data: table === "accounts" ? { id: "acc_1", stripe_connection_status: "connected" } : null, error: null };
    const chain: Record<string, unknown> = {};
    for (const m of ["select", "eq", "neq", "in", "is", "lt", "lte", "gte", "order", "limit", "update", "upsert", "insert"]) {
      chain[m] = () => chain;
    }
    chain.maybeSingle = async () => result;
    chain.single = async () => result;
    chain.then = (resolve: (v: unknown) => unknown) => resolve({ data: [], error: null });
    return chain;
  };
  return { from: builder } as never;
}

function ledgerWithSave() {
  const db = fakeLedger({ clock: () => new Date("2026-10-05T00:00:00Z") });
  db.addAccount();
  const save = db.addSave({ status: "verified", verified_at: "2026-09-01T00:00:00Z", fee_cents: 2_000 });
  db.addLine({ save_id: save.id, stripe_invoice_id: "in_1", amount_cents: 2_000, invoice_amount_paid_cents: 10_000 });
  const deps = {
    ledgerRepo: () => db.repo,
    invoiceForPayment: async (_acct: string, ref: { chargeId?: string | null; paymentIntentId?: string | null }) =>
      ref.paymentIntentId === "pi_1" || ref.chargeId === "ch_1" ? "in_1" : null,
    invoiceAmountPaid: async () => 10_000,
    now: () => new Date("2026-10-05T00:00:00Z"),
  };
  return { db, save, deps };
}

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
        "charge.refunded",
        "credit_note.created",
        "credit_note.updated",
        "credit_note.voided",
        "charge.dispute.created",
        "charge.dispute.updated",
        "charge.dispute.closed",
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

describe("week 4: clawback and dispute events", () => {
  const evt = (type: string, object: Record<string, unknown>) => ({ id: `evt_${type}`, type, account: "acct_1", created: 1_790_000_000, data: { object } });

  it("charge.refunded claws back the fee line of the invoice it paid, pro-rata", async () => {
    const { db, save, deps } = ledgerWithSave();
    const charge = { id: "ch_1", payment_intent: "pi_1", amount: 10_000, amount_captured: 10_000, amount_refunded: 3_000 };
    await expect(handleStripeEvent(stubAdmin(), evt("charge.refunded", charge) as never, deps)).resolves.toBe("processed");
    expect(db.lines[0]!.clawed_back_cents).toBe(600);
    expect(db.saves.get(save.id)!.fee_cents).toBe(1_400);
  });

  it("ignores refunds on charges that aren't an invoice payment", async () => {
    const { db, deps } = ledgerWithSave();
    const charge = { id: "ch_x", payment_intent: "pi_x", amount: 500, amount_captured: 500, amount_refunded: 500 };
    await expect(handleStripeEvent(stubAdmin(), evt("charge.refunded", charge) as never, deps)).resolves.toBe("ignored");
    expect(db.reversals).toHaveLength(0);
  });

  it("credit notes count only their non-refund part", async () => {
    const { db, deps } = ledgerWithSave();
    const note = { id: "cn_1", invoice: "in_1", status: "issued", post_payment_amount: 5_000, refunds: [{ amount_refunded: 4_000 }] };
    await expect(handleStripeEvent(stubAdmin(), evt("credit_note.created", note) as never, deps)).resolves.toBe("processed");
    expect(db.lines[0]!.clawed_back_cents).toBe(200); // $10 of $100 -> 10% of the $20 fee
  });

  it("charge.dispute.created holds, charge.dispute.closed (lost) reverses", async () => {
    const { db, deps } = ledgerWithSave();
    const dispute = { id: "dp_1", charge: "ch_1", payment_intent: "pi_1", amount: 10_000, status: "needs_response" };
    await expect(handleStripeEvent(stubAdmin(), evt("charge.dispute.created", dispute) as never, deps)).resolves.toBe("processed");
    expect(db.lines[0]!.held_stripe_dispute_id).toBe("dp_1");
    await handleStripeEvent(stubAdmin(), evt("charge.dispute.closed", { ...dispute, status: "lost" }) as never, deps);
    expect(db.lines[0]).toMatchObject({ held_stripe_dispute_id: null, clawed_back_cents: 2_000, status: "clawed_back" });
  });

  it("invoice.paid adds the next fee month and calls onInvoicePaid (receipt emails)", async () => {
    const { db, save, deps } = ledgerWithSave();
    db.saves.get(save.id)!.created_at = "2026-08-01T00:00:00Z";
    const seen: string[] = [];
    const invoice = {
      id: "in_2",
      parent: { subscription_details: { subscription: "sub_1" } },
      amount_paid: 10_000,
      created: Date.parse("2026-10-01T00:00:00Z") / 1000,
      billing_reason: "subscription_cycle",
      customer_email: "jamie@example.com",
      status_transitions: { paid_at: Date.parse("2026-10-01T01:00:00Z") / 1000 },
    };
    await handleStripeEvent(stubAdmin(), evt("invoice.paid", invoice) as never, { ...deps, onInvoicePaid: async (a: string) => void seen.push(a) });
    expect(db.lines.map((l) => [l.month_index, l.stripe_invoice_id])).toEqual([
      [1, "in_1"],
      [2, "in_2"],
    ]);
    expect(seen).toEqual(["acc_1"]);
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
