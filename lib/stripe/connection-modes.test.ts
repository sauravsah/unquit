/**
 * Every founder-account Stripe path works in BOTH connection modes:
 *   connect  platform client + { stripeAccount: "acct_…" } on every call
 *   key      the founder's own client (built from their decrypted restricted key), no Stripe-Account header
 */
import { randomBytes } from "node:crypto";
import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { connectTarget, keyTarget, targetForRow, createStripeResolver, sealForAccount } = await import("./connection");
const { fakeStripe, stripeErrors } = await import("./testing/fake-stripe");
const { createStripeOps, listRecurringPrices } = await import("@/lib/widget/stripe-ops");
const { createCardUpdateStripe, createDunningStripe, lookupDecline } = await import("@/lib/dunning/stripe-ops");
const { createEvidenceStripe, invoiceAmountPaid, invoiceForCharge } = await import("@/lib/ledger/stripe-ops");
const { elementsFor } = await import("@/lib/dunning/card-update");
const { handleStripeEvent } = await import("./webhook-handlers");
const { createTestDb, addFounder } = await import("@/lib/db/testing/pglite");

const ENC = randomBytes(32).toString("base64");
const RK = "rk_test_51FounderKeyAbcdefghijklmnopqrstuvwxyz0123456789";
const ACCT = "acct_founder";

const SUB = {
  id: "sub_1",
  object: "subscription",
  customer: "cus_1",
  status: "active",
  currency: "usd",
  livemode: false,
  items: { data: [{ id: "si_1", quantity: 1, price: { id: "price_pro", unit_amount: 5_000, currency: "usd", recurring: { interval: "month", interval_count: 1 } } }] },
  discounts: [],
  cancel_at_period_end: false,
  pause_collection: null,
};
const INVOICE = {
  id: "in_1",
  status: "open",
  customer: "cus_1",
  amount_due: 5_000,
  amount_remaining: 5_000,
  amount_paid: 0,
  currency: "usd",
  number: "INV-1",
  hosted_invoice_url: null,
  status_transitions: {},
  payments: { data: [{ payment: { payment_intent: { id: "pi_1", created: 1, status: "requires_payment_method", last_payment_error: { decline_code: "insufficient_funds", code: "card_declined", message: "no" } } } }] },
};

function handlers() {
  return {
    "subscriptions.retrieve": () => SUB,
    "subscriptions.update": () => SUB,
    "subscriptions.cancel": () => SUB,
    "coupons.retrieve": () => {
      throw stripeErrors.missing();
    },
    "coupons.create": () => ({ id: "unquit_30off_3m" }),
    "prices.retrieve": () => ({ id: "price_basic", active: true, currency: "usd", unit_amount: 2_000, recurring: { interval: "month", interval_count: 1 }, product: { name: "Basic" } }),
    "prices.list": () => ({ data: [{ id: "price_basic", active: true, currency: "usd", unit_amount: 2_000, recurring: { interval: "month", interval_count: 1 }, product: { name: "Basic" } }] }),
    "invoices.retrieve": () => INVOICE,
    "invoices.pay": () => ({ ...INVOICE, status: "paid", amount_paid: 5_000, amount_remaining: 0 }),
    "setupIntents.create": () => ({ id: "seti_1", client_secret: "seti_1_secret" }),
    "setupIntents.retrieve": () => ({ id: "seti_1", status: "succeeded", customer: "cus_1", payment_method: "pm_1", metadata: { unquit_dunning_case: "case_1" } }),
    "customers.update": () => ({ id: "cus_1" }),
    "charges.retrieve": () => ({ id: "ch_1", payment_intent: "pi_1" }),
    "invoicePayments.list": () => ({ data: [{ invoice: "in_1", payment: { payment_intent: { latest_charge: { amount_refunded: 0 } } } }] }),
  };
}

type Mode = "connect" | "key";

/** A target + the fake behind it, for either mode. */
function setup(mode: Mode) {
  const platform = fakeStripe(handlers(), "platform");
  const founder = fakeStripe(handlers(), "founder");
  const target = mode === "connect" ? connectTarget(platform.client, ACCT) : keyTarget(founder.client, ACCT, "pk_test_founder123456");
  const used = mode === "connect" ? founder : platform; // the one that must NOT be touched
  const active = mode === "connect" ? platform : founder;
  return { target, active, untouched: used, resolve: async () => target };
}

function expectOptions(mode: Mode, options: unknown, extra: Record<string, unknown> = {}) {
  if (mode === "connect") expect(options).toEqual({ stripeAccount: ACCT, ...extra });
  else {
    expect(options).toEqual({ ...extra });
    expect(options).not.toHaveProperty("stripeAccount");
  }
}

describe("targetForRow", () => {
  const deps = (clientForKey = vi.fn((_k: string) => fakeStripe({}, "founder").client)) => ({
    platform: () => fakeStripe({}, "platform").client,
    clientForKey,
    encryptionKey: () => ENC,
  });

  it("connect mode (or no row): the platform client with the Stripe-Account header", () => {
    for (const row of [null, { id: "a", stripe_account_id: ACCT, stripe_connection_mode: "connect" as const, stripe_key_ciphertext: null, stripe_publishable_key: null }]) {
      const t = targetForRow(row, ACCT, deps());
      expect(t.mode).toBe("connect");
      expect(t.on).toEqual({ stripeAccount: ACCT });
      expect(t.publishableKey).toBeNull();
    }
  });

  it("key mode: decrypts the founder's key into its own client, no header", () => {
    const clientForKey = vi.fn((_k: string) => fakeStripe({}, "founder").client);
    const row = { id: "acc-1", stripe_account_id: ACCT, stripe_connection_mode: "key" as const, stripe_key_ciphertext: sealForAccount(RK, "acc-1", ENC), stripe_publishable_key: "pk_test_abc1234567" };
    const t = targetForRow(row, ACCT, deps(clientForKey));
    expect(t.mode).toBe("key");
    expect(t.on).toEqual({});
    expect(t.publishableKey).toBe("pk_test_abc1234567");
    expect(clientForKey).toHaveBeenCalledWith(RK);
  });

  it("key mode fails closed without the encryption key, or with a ciphertext from another account", () => {
    const row = { id: "acc-1", stripe_account_id: ACCT, stripe_connection_mode: "key" as const, stripe_key_ciphertext: sealForAccount(RK, "acc-1", ENC), stripe_publishable_key: null };
    expect(() => targetForRow(row, ACCT, { ...deps(), encryptionKey: () => undefined })).toThrow(/STRIPE_KEY_ENCRYPTION_KEY/);
    expect(() => targetForRow({ ...row, id: "acc-2" }, ACCT, deps())).toThrow(/decrypt/);
    expect(() => targetForRow({ ...row, stripe_key_ciphertext: null }, ACCT, deps())).toThrow(/missing/);
  });
});

describe("createStripeResolver (database-backed)", () => {
  let db: Awaited<ReturnType<typeof createTestDb>>;
  beforeAll(async () => {
    db = await createTestDb();
  }, 60_000);

  it("picks each account's mode, decrypts once per resolver, and keeps old disconnected rows out of the way", async () => {
    const connect = await addFounder(db, { stripe: "acct_connect" });
    const keyed = await addFounder(db, { stripe: "acct_keyed" });
    await db.query(
      `update accounts set stripe_connection_mode = 'key', stripe_key_ciphertext = $2, stripe_key_last4 = $3,
              stripe_publishable_key = 'pk_test_keyed123456', stripe_webhook_endpoint_id = 'we_1', stripe_webhook_secret_ciphertext = $4
        where id = $1`,
      [keyed.accountId, sealForAccount(RK, keyed.accountId, ENC), RK.slice(-4), sealForAccount("whsec_x", keyed.accountId, ENC)],
    );
    // An older, disconnected key-mode row for the same Stripe account must not win.
    const old = await addFounder(db);
    await db.query("update accounts set stripe_account_id = 'acct_connect', stripe_connection_status = 'disconnected', stripe_connection_mode = 'key' where id = $1", [old.accountId]);

    const clientForKey = vi.fn((_k: string) => fakeStripe({}, "founder").client);
    const resolve = createStripeResolver(db as never, { platform: () => fakeStripe({}, "platform").client, clientForKey, encryptionKey: () => ENC });

    const a = await resolve("acct_connect");
    expect(a.mode).toBe("connect");
    expect(a.on).toEqual({ stripeAccount: "acct_connect" });

    const b = await resolve("acct_keyed");
    const again = await resolve("acct_keyed");
    expect(b.mode).toBe("key");
    expect(b.on).toEqual({});
    expect(b.publishableKey).toBe("pk_test_keyed123456");
    expect(again).toBe(b);
    expect(clientForKey).toHaveBeenCalledTimes(1);
    expect(clientForKey).toHaveBeenCalledWith(RK);
    expect(connect.accountId).toBeTruthy();
  });
});

describe.each<Mode>(["connect", "key"])("%s mode", (mode) => {
  it("widget: reads the subscription and price, applies a discount (coupon + update) and cancels", async () => {
    const { target, active, untouched } = setup(mode);
    const ops = createStripeOps(target);
    const sub = await ops.getSubscription("sub_1");
    expect(sub?.mrrCents).toBe(5_000);
    expect((await ops.getPrice("price_basic"))?.productName).toBe("Basic");
    await ops.applyOffer(sub!, { type: "discount", percentOff: 30, months: 3 } as never, "idem_1", "sess_1");
    await ops.cancel(sub!, "period_end", { feedback: "too_expensive", comment: null } as never, "idem_2");

    expectOptions(mode, active.optionsOf("subscriptions.retrieve")[0]);
    expectOptions(mode, active.optionsOf("coupons.retrieve")[0]);
    expectOptions(mode, active.optionsOf("coupons.create")[0], { idempotencyKey: "idem_1_coupon" });
    expectOptions(mode, active.optionsOf("subscriptions.update")[0], { idempotencyKey: "idem_1" });
    expectOptions(mode, active.optionsOf("subscriptions.update")[1], { idempotencyKey: "idem_2" });
    expect(untouched.calls).toHaveLength(0);
  });

  it("flow editor: lists recurring prices", async () => {
    const { target, active } = setup(mode);
    expect(await listRecurringPrices(target)).toHaveLength(1);
    expectOptions(mode, active.optionsOf("prices.list")[0]);
  });

  it("dunning: decline lookup and live state", async () => {
    const { active, untouched, resolve } = setup(mode);
    const decline = await lookupDecline(resolve, ACCT, "in_1");
    expect(decline.declineCode).toBe("insufficient_funds");
    const state = await createDunningStripe(resolve).getLiveState(ACCT, "in_1", "sub_1");
    expect(state).toEqual({ invoiceStatus: "open", subscriptionStatus: "active" });
    for (const o of active.optionsOf("invoices.retrieve")) expectOptions(mode, o);
    expectOptions(mode, active.optionsOf("subscriptions.retrieve")[0]);
    expect(untouched.calls).toHaveLength(0);
  });

  it("card-update page: SetupIntent, default card, pay the invoice", async () => {
    const { active, untouched, resolve } = setup(mode);
    const stripe = createCardUpdateStripe(resolve);
    expect((await stripe.getInvoice(ACCT, "in_1"))?.amountDueCents).toBe(5_000);
    await stripe.createSetupIntent(ACCT, { customerId: "cus_1", caseId: "case_1", idempotencyKey: "k1" });
    expect((await stripe.getSetupIntent(ACCT, "seti_1"))?.paymentMethodId).toBe("pm_1");
    await stripe.setDefaultPaymentMethod(ACCT, { customerId: "cus_1", subscriptionId: "sub_1", paymentMethodId: "pm_1", idempotencyKey: "k2" });
    const paid = await stripe.payInvoice(ACCT, "in_1", { paymentMethodId: "pm_1", idempotencyKey: "k3" });
    expect(paid.status).toBe("paid");

    expectOptions(mode, active.optionsOf("setupIntents.create")[0], { idempotencyKey: "k1" });
    expectOptions(mode, active.optionsOf("customers.update")[0], { idempotencyKey: "k2_customer" });
    expectOptions(mode, active.optionsOf("subscriptions.update")[0], { idempotencyKey: "k2_subscription" });
    expectOptions(mode, active.optionsOf("invoices.pay")[0], { idempotencyKey: "k3" });
    expect(untouched.calls).toHaveLength(0);
  });

  it("verification and clawbacks: invoice evidence, refund → invoice, amount paid", async () => {
    const { active, untouched, resolve } = setup(mode);
    const evidence = await createEvidenceStripe(resolve).getInvoiceEvidence(ACCT, "in_1");
    expect(evidence?.id).toBe("in_1");
    expect(await invoiceForCharge(resolve, ACCT, "ch_1")).toBe("in_1");
    expect(await invoiceAmountPaid(resolve, ACCT, "in_1")).toBe(0);
    for (const m of ["invoices.retrieve", "invoicePayments.list", "charges.retrieve"]) {
      for (const o of active.optionsOf(m)) expectOptions(mode, o);
    }
    expect(untouched.calls).toHaveLength(0);
  });

  it("webhook defaults use the resolver (decline lookup on invoice.payment_failed)", async () => {
    const { active, resolve } = setup(mode);
    const queries: string[] = [];
    const db = {
      async query(text: string) {
        queries.push(text);
        return /from accounts/.test(text) ? [{ id: "acc_1", stripe_connection_status: "connected" }] : [];
      },
    } as never;
    const event = {
      id: "evt_f",
      type: "invoice.payment_failed",
      created: 1_790_000_000,
      ...(mode === "connect" ? { account: ACCT } : {}),
      data: { object: { ...INVOICE, status: "open", attempt_count: 1, customer_email: "c@example.com", parent: { subscription_details: { subscription: "sub_1" } } } },
    };
    await handleStripeEvent(db, event as never, { resolveStripe: resolve, ...(mode === "key" ? { directStripeAccountId: ACCT } : {}) }).catch(() => "db-stub");
    expect(active.methods()).toContain("invoices.retrieve");
    expectOptions(mode, active.optionsOf("invoices.retrieve")[0]);
  });
});

describe("card-update page Elements target", () => {
  const base = { id: "case_1", account: { id: "acc_1", name: "Acme", stripe_account_id: ACCT } } as never;
  it("Connect mode: platform publishable key on the founder's acct_", () => {
    expect(elementsFor(base)).toEqual({ stripeAccount: ACCT, publishableKey: null });
  });
  it("key mode: the founder's own publishable key, no Stripe-Account", () => {
    const c = { id: "case_1", account: { id: "acc_1", name: "Acme", stripe_account_id: ACCT, stripe_connection_mode: "key", stripe_publishable_key: "pk_test_f1234567890" } } as never;
    expect(elementsFor(c)).toEqual({ stripeAccount: null, publishableKey: "pk_test_f1234567890" });
  });
});

describe("direct (restricted-key) webhook events", () => {
  const db = { async query(text: string) { return /from accounts/.test(text) ? [{ id: "acc_1", stripe_connection_status: "connected" }] : []; } } as never;

  it("ignores Connect events (with an `account`) arriving on a direct endpoint", async () => {
    const event = { id: "evt_c", type: "customer.subscription.updated", account: "acct_other", data: { object: SUB } };
    await expect(handleStripeEvent(db, event as never, { directStripeAccountId: ACCT })).resolves.toBe("ignored");
  });

  it("ignores account.application.deauthorized (Connect-only)", async () => {
    const event = { id: "evt_d", type: "account.application.deauthorized", data: { object: {} } };
    await expect(handleStripeEvent(db, event as never, { directStripeAccountId: ACCT })).resolves.toBe("ignored");
  });

  it("processes account-less events for the endpoint's own account", async () => {
    const seen: unknown[][] = [];
    const recording = {
      async query(text: string, params: unknown[] = []) {
        seen.push([text, params]);
        return /from accounts/.test(text) ? [{ id: "acc_1", stripe_connection_status: "connected" }] : [];
      },
    } as never;
    const event = { id: "evt_s", type: "customer.subscription.updated", created: 1_790_000_000, data: { object: SUB } };
    await expect(handleStripeEvent(recording, event as never, { directStripeAccountId: ACCT })).resolves.toBe("processed");
    expect(seen.find(([t]) => /from accounts/.test(String(t)))?.[1]).toEqual([ACCT]);
  });
});
