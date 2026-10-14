/**
 * Dodo test mode vs live mode (migration 0010, methodForEnvironment): ids
 * saved with the test key never exist for the live key, so a mandate from the
 * other environment must read as "no card": never charged, never shown, and
 * never reused as the Dodo customer for a new checkout.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadMigrations, migrate } from "@/db/migrate-core.mjs";
import { addFounder, createTestDb, migrateClient, type TestDb } from "@/lib/db/testing/pglite";
import type { DodoEnvironment, DodoSubscription } from "./client";
import { fakeDodo, type FakeDodo } from "./testing";

vi.mock("server-only", () => ({}));
const { createBillingRepo } = await import("@/lib/billing/repo");
const { runMonthlyBilling } = await import("@/lib/billing/service");
const { loadBillingPage } = await import("@/lib/billing/dashboard");
const svc = await import("./service");
const { MIN_CHARGE_CENTS } = await import("./policy");

const DAY = 86_400_000;
const OCT_1 = new Date(Date.UTC(2026, 9, 1, 6, 0, 0));

let db: TestDb;
let testDodo: FakeDodo;
let liveDodo: FakeDodo;
let clock: Date;
let mail: { accountId: string; subject: string }[];
let seq = 0;

beforeEach(async () => {
  db = await createTestDb();
  testDodo = fakeDodo({ productId: "pdt_test_usage", environment: "test_mode" });
  liveDodo = fakeDodo({ productId: "pdt_live_usage", environment: "live_mode" });
  clock = OCT_1;
  mail = [];
}, 60_000);

function deps(dodo: FakeDodo): import("./service").DodoBillingDeps {
  return {
    db,
    dodo: dodo.client,
    productId: dodo.productId,
    appUrl: "https://app.unquit.test",
    now: () => clock,
    mailer: {
      async toFounder(accountId, email) {
        mail.push({ accountId, subject: email.subject });
        return true;
      },
    },
  };
}

function billing(): import("@/lib/billing/service").BillingDeps {
  return {
    repo: createBillingRepo(db),
    appUrl: "https://app.unquit.test",
    now: () => clock,
    collector: {
      minChargeCents: MIN_CHARGE_CENTS,
      claimCarryIn: (accountId, periodId) => svc.claimCarryIn(db, accountId, periodId),
      scheduleCharge: (input) => svc.scheduleCharge(db, input),
    },
  };
}

function rawSub(sub: DodoSubscription): Record<string, unknown> {
  return {
    subscription_id: sub.subscription_id,
    status: sub.status,
    product_id: sub.product_id,
    customer: { customer_id: sub.customer_id, email: sub.customer_email },
    on_demand: sub.on_demand,
    payment_method_id: sub.payment_method_id,
    metadata: sub.metadata,
  };
}

/** One verified dunning save with one fee line of `cents` in September 2026. */
async function septemberFee(accountId: string, cents: number): Promise<void> {
  seq++;
  const caseId = await db.value<string>(
    `insert into dunning_cases (account_id, stripe_invoice_id, stripe_customer_id, amount_due_cents, status, recovered_via, recovered_amount_cents, recovered_at, decline_category)
     values ($1, $2, 'cus_x', $3, 'recovered', 'update_link', $3, now(), 'soft') returning id`,
    [accountId, `in_env_${seq}`, cents * 10],
  );
  const saveId = await db.value<string>(
    `insert into saves (account_id, type, dunning_case_id, stripe_customer_id, stripe_invoice_id, recovered_amount_cents, fee_cents, status, verified_at, attributed_via)
     values ($1, 'dunning', $2, 'cus_x', $3, $4, $5, 'verified', now(), 'update_link') returning id`,
    [accountId, caseId, `in_env_${seq}`, cents * 10, cents],
  );
  await db.value<string>(
    `insert into save_fee_lines (save_id, account_id, month_index, billing_month, stripe_invoice_id, amount_cents, invoice_amount_paid_cents, clawed_back_cents)
     values ($1, $2, 1, '2026-09-01', $3, $4, $5, 0) returning id`,
    [saveId, accountId, `in_env_${seq}`, cents, cents * 10],
  );
}

/** A founder whose card was saved through the TEST-mode checkout (like Saurav's own e2e account). */
async function founderWithTestCard(email = "maker@example.com") {
  const { accountId } = await addFounder(db, { stripe: `acct_env_${++seq}`, email });
  const sub = testDodo.subscription("sub_test_1", accountId, { customer_id: "cus_test_1", product_id: testDodo.productId });
  testDodo.paymentMethods.set("cus_test_1", [{ payment_method_id: "pm_1", brand: "VISA", last4: "4242" }]);
  await svc.handleDodoEvent(deps(testDodo), { type: "subscription.active", timestamp: new Date(clock.getTime() - DAY).toISOString(), data: rawSub(sub) });
  return { accountId };
}

const accountRow = (accountId: string) =>
  db.query<Record<string, unknown>>(
    `select dodo_environment, dodo_customer_id, dodo_subscription_id, dodo_payment_method_id, billing_pm_status, billing_pm_brand, billing_pm_last4, dodo_mandate_at
       from accounts where id = $1`,
    [accountId],
  ).then((r) => r[0]!);

describe("migration 0010", () => {
  it("marks every Dodo id saved before it as test mode, and leaves accounts without one alone", async () => {
    const old = await createTestDb({ upTo: "0009" });
    const withCard = await addFounder(old, { stripe: "acct_pre_0010" });
    const without = await addFounder(old, { stripe: "acct_pre_0010b" });
    await old.query("update accounts set dodo_customer_id = 'cus_t', dodo_subscription_id = 'sub_t', dodo_subscription_status = 'active' where id = $1", [withCard.accountId]);
    const result = await migrate(migrateClient(old.pg), { migrations: loadMigrations() });
    expect(result.applied[0]).toBe("0010_dodo_environment.sql");
    expect(await old.value("select dodo_environment from accounts where id = $1", [withCard.accountId])).toBe("test_mode");
    expect(await old.value("select dodo_environment from accounts where id = $1", [without.accountId])).toBeNull();
    await expect(old.query("update accounts set dodo_environment = 'prod' where id = $1", [without.accountId])).rejects.toThrow();
  }, 60_000);
});

describe("methodForEnvironment", () => {
  const method = {
    id: "acc",
    name: null,
    owner_user_id: "u",
    dodo_customer_id: "cus_test_1",
    dodo_subscription_id: "sub_test_1",
    dodo_subscription_status: "active",
    dodo_status_at: "2026-10-01T00:00:00Z",
    dodo_mandate_at: "2026-10-01T00:00:00Z",
    billing_pm_brand: "VISA",
    billing_pm_last4: "4242",
  };

  it("keeps a method from the same environment untouched", () => {
    const m = { ...method, dodo_environment: "live_mode" as DodoEnvironment };
    expect(svc.methodForEnvironment(m, "live_mode")).toBe(m);
  });

  it("treats a method from the other environment as no card", () => {
    const seen = svc.methodForEnvironment({ ...method, dodo_environment: "test_mode" as DodoEnvironment }, "live_mode");
    expect(seen).toMatchObject({
      dodo_customer_id: null,
      dodo_subscription_id: null,
      dodo_subscription_status: null,
      dodo_mandate_at: null,
      billing_pm_brand: null,
      billing_pm_last4: null,
    });
    expect(svc.isChargeable(seen.dodo_subscription_status)).toBe(false);
  });

  it("reads rows from before migration 0010 (no environment) as test mode", () => {
    const legacy = { ...method, dodo_environment: null };
    expect(svc.methodForEnvironment(legacy, "test_mode")).toBe(legacy);
    expect(svc.methodForEnvironment(legacy, "live_mode").dodo_subscription_id).toBeNull();
  });
});

describe("a test-mode mandate after switching to live mode", () => {
  it("records the environment a card was saved in", async () => {
    const { accountId } = await founderWithTestCard();
    expect(await accountRow(accountId)).toMatchObject({ dodo_environment: "test_mode", dodo_subscription_id: "sub_test_1", billing_pm_status: "active" });
  });

  it("is never charged with the live key: the statement waits for a card instead", async () => {
    const { accountId } = await founderWithTestCard();
    await septemberFee(accountId, 2_000);
    await runMonthlyBilling(billing());
    const charged = await svc.chargeDue(deps(liveDodo));
    expect(charged).toMatchObject({ due: 1, awaiting_card: 1 });
    expect(liveDodo.charges).toHaveLength(0);
    expect(testDodo.charges).toHaveLength(0);
    expect(await db.value("select status from billing_charges where account_id = $1", [accountId])).toBe("awaiting_card");
    expect(mail.map((m) => m.subject)).toEqual(["Add a card to pay your unquit statement ($20.00)"]);
  });

  it("is still charged in test mode (preview deployments keep working)", async () => {
    const { accountId } = await founderWithTestCard();
    await septemberFee(accountId, 2_000);
    await runMonthlyBilling(billing());
    expect(await svc.chargeDue(deps(testDodo))).toMatchObject({ sent: 1 });
    expect(testDodo.charges[0]).toMatchObject({ subscriptionId: "sub_test_1", amountCents: 2_000 });
  });

  it("starts a fresh live checkout by email, never with the test customer or update-payment-method", async () => {
    const { accountId } = await founderWithTestCard("owner@example.com");
    const start = await svc.startBillingMethod(deps(liveDodo), accountId);
    expect(start.kind).toBe("checkout");
    expect(liveDodo.updates).toHaveLength(0);
    expect(liveDodo.checkouts[0]).toMatchObject({ productId: "pdt_live_usage", customer: { email: "owner@example.com" } });
  });

  it("shows no card on the billing page in live mode, and the card in test mode", async () => {
    const { accountId } = await founderWithTestCard();
    const live = await loadBillingPage(db, accountId, "live_mode");
    expect(live.account).toMatchObject({ billing_pm_status: "none", billing_pm_last4: null, dodo_subscription_id: null, dodo_mandate_at: null });
    const test = await loadBillingPage(db, accountId, "test_mode");
    expect(test.account).toMatchObject({ billing_pm_status: "active", billing_pm_last4: "4242", dodo_subscription_id: "sub_test_1" });
  });

  it("replaces the test ids when the founder saves a live card, then charges the live subscription", async () => {
    const { accountId } = await founderWithTestCard();
    await septemberFee(accountId, 2_000);
    await runMonthlyBilling(billing());
    expect(await svc.chargeDue(deps(liveDodo))).toMatchObject({ awaiting_card: 1 });

    clock = new Date(OCT_1.getTime() + DAY);
    // The live checkout's subscription: no payment method id on the event, a live customer.
    const liveSub = liveDodo.subscription("sub_live_1", accountId, { customer_id: "cus_live_1", payment_method_id: null, product_id: liveDodo.productId });
    liveDodo.paymentMethods.set("cus_live_1", [{ payment_method_id: "pm_live", brand: "MASTERCARD", last4: "5555" }]);
    expect(await svc.handleDodoEvent(deps(liveDodo), { type: "subscription.active", timestamp: clock.toISOString(), data: rawSub(liveSub) })).toBe("processed");

    const row = await accountRow(accountId);
    expect(row).toMatchObject({
      dodo_environment: "live_mode",
      dodo_customer_id: "cus_live_1",
      dodo_subscription_id: "sub_live_1",
      // The test payment method id is not carried over into live.
      dodo_payment_method_id: null,
      billing_pm_status: "active",
      billing_pm_brand: "MASTERCARD",
      billing_pm_last4: "5555",
    });
    expect(new Date(row.dodo_mandate_at as string).toISOString()).toBe(clock.toISOString());

    expect(await svc.chargeDue(deps(liveDodo))).toMatchObject({ sent: 1 });
    expect(liveDodo.charges).toEqual([expect.objectContaining({ subscriptionId: "sub_live_1", amountCents: 2_000 })]);
    expect(testDodo.charges).toHaveLength(0);

    // Now the test key is the one that sees "no card".
    const seenFromTest = await loadBillingPage(db, accountId, "test_mode");
    expect(seenFromTest.account.billing_pm_status).toBe("none");
  });
});
