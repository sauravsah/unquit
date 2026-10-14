/**
 * unquit's own fees through Dodo Payments, end to end against a real Postgres
 * (PGlite + every migration) and a fake Dodo client: the billing method
 * (on-demand mandate), the monthly statement -> charge amounts, idempotency,
 * webhooks, and Dodo's safe retry policy.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { addFounder, createTestDb, type TestDb } from "@/lib/db/testing/pglite";
import { fakeDodo, type FakeDodo } from "./testing";

vi.mock("server-only", () => ({}));
const { createBillingRepo } = await import("@/lib/billing/repo");
const { runMonthlyBilling } = await import("@/lib/billing/service");
const svc = await import("./service");
const { MIN_CHARGE_CENTS } = await import("./policy");

const DAY = 86_400_000;
const at = (y: number, m: number, d: number, h = 6, min = 0) => new Date(Date.UTC(y, m - 1, d, h, min, 0));
const OCT_1 = at(2026, 10, 1);
const NOV_1 = at(2026, 11, 1);
const DEC_1 = at(2026, 12, 1);

let db: TestDb;
let dodo: FakeDodo;
let clock: Date;
let mail: { accountId: string; subject: string; key: string }[];
let seq = 0;

beforeEach(async () => {
  db = await createTestDb();
  dodo = fakeDodo({ productId: "pdt_usage" });
  clock = OCT_1;
  mail = [];
}, 60_000);

function deps(): import("./service").DodoBillingDeps {
  return {
    db,
    dodo: dodo.client,
    productId: dodo.productId,
    appUrl: "https://app.unquit.test",
    now: () => clock,
    mailer: {
      async toFounder(accountId, email) {
        mail.push({ accountId, subject: email.subject, key: email.idempotencyKey });
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

/** One verified dunning save with one fee line of `cents` in `month` ("2026-09-01"). */
async function fee(accountId: string, month: string, cents: number, clawedBack = 0): Promise<string> {
  seq++;
  const caseId = await db.value<string>(
    `insert into dunning_cases (account_id, stripe_invoice_id, stripe_customer_id, amount_due_cents, status, recovered_via, recovered_amount_cents, recovered_at, decline_category)
     values ($1, $2, 'cus_x', $3, 'recovered', 'update_link', $3, now(), 'soft') returning id`,
    [accountId, `in_${seq}`, cents * 10],
  );
  const saveId = await db.value<string>(
    `insert into saves (account_id, type, dunning_case_id, stripe_customer_id, stripe_invoice_id, recovered_amount_cents, fee_cents, status, verified_at, attributed_via)
     values ($1, 'dunning', $2, 'cus_x', $3, $4, $5, 'verified', now(), 'update_link') returning id`,
    [accountId, caseId, `in_${seq}`, cents * 10, cents],
  );
  return db.value<string>(
    `insert into save_fee_lines (save_id, account_id, month_index, billing_month, stripe_invoice_id, amount_cents, invoice_amount_paid_cents, clawed_back_cents)
     values ($1, $2, 1, $3, $4, $5, $6, $7) returning id`,
    [saveId, accountId, month, `in_${seq}`, cents, cents * 10, clawedBack],
  );
}

async function founderWithCard(name = "acme") {
  const { accountId } = await addFounder(db, { stripe: `acct_${name}_${++seq}` });
  const sub = dodo.subscription(`sub_${name}_${seq}`, accountId);
  dodo.paymentMethods.set("cus_dodo_1", [{ payment_method_id: "pm_1", brand: "VISA", last4: "4242" }]);
  await svc.handleDodoEvent(deps(), { type: "subscription.active", timestamp: new Date(clock.getTime() - DAY).toISOString(), data: { ...rawSub(sub) } });
  return { accountId, subscriptionId: sub.subscription_id };
}

function rawSub(sub: import("./client").DodoSubscription): Record<string, unknown> {
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

function rawPayment(p: import("./client").DodoPayment): Record<string, unknown> {
  return { ...p, customer: { customer_id: p.customer_id } };
}

const charges = (accountId: string) => db.query<import("./service").ChargeRow>(`select ${svc.CHARGE_COLUMNS} from billing_charges where account_id = $1`, [accountId]);
const period = (accountId: string, month: string) =>
  db.query<Record<string, unknown>>("select * from billing_periods where account_id = $1 and period_month = $2", [accountId, month]).then((r) => r[0]!);

async function webhookPayment(paymentId: string, status: "succeeded" | "failed", fields: Partial<import("./client").DodoPayment> = {}) {
  const p = dodo.settle(paymentId, status, fields);
  return svc.handleDodoEvent(deps(), { type: `payment.${status}`, timestamp: clock.toISOString(), data: rawPayment(p) });
}

/** Closes last month's statements and charges what's due, like the cron on the 1st. */
async function monthlyRun() {
  const statements = await runMonthlyBilling(billing());
  const charged = await svc.chargeDue(deps());
  return { statements, charged };
}

describe("billing method (Dodo on-demand mandate)", () => {
  it("starts a mandate-only checkout for the usage product, then stores the subscription from the webhook", async () => {
    const { accountId } = await addFounder(db, { stripe: "acct_m", email: "maker@example.com" });
    const start = await svc.startBillingMethod(deps(), accountId);
    expect(start.kind).toBe("checkout");
    expect(dodo.checkouts[0]).toMatchObject({
      productId: "pdt_usage",
      customer: { email: "maker@example.com" },
      returnUrl: "https://app.unquit.test/dashboard/billing?card=saved",
      metadata: { unquit_account_id: accountId, unquit_purpose: "billing_method" },
    });
    expect(await db.value("select dodo_checkout_session_id from accounts where id = $1", [accountId])).toBe(dodo.checkouts[0]!.sessionId);

    const sub = dodo.subscription("sub_m", accountId);
    dodo.paymentMethods.set("cus_dodo_1", [{ payment_method_id: "pm_1", brand: "VISA", last4: "4242" }]);
    expect(await svc.handleDodoEvent(deps(), { type: "subscription.active", timestamp: clock.toISOString(), data: rawSub(sub) })).toBe("processed");
    const row = (await db.query<Record<string, unknown>>("select * from accounts where id = $1", [accountId]))[0]!;
    expect(row).toMatchObject({
      dodo_subscription_id: "sub_m",
      dodo_customer_id: "cus_dodo_1",
      dodo_subscription_status: "active",
      dodo_payment_method_id: "pm_1",
      billing_pm_status: "active",
      billing_pm_brand: "VISA",
      billing_pm_last4: "4242",
    });
    expect(row.dodo_mandate_at).not.toBeNull();
    // No money moved.
    expect(dodo.charges).toHaveLength(0);

    // With a card on file, "Update card" uses Dodo's update-payment-method flow.
    const update = await svc.startBillingMethod(deps(), accountId);
    expect(update.kind).toBe("update_payment_method");
    expect(dodo.updates[0]!.subscriptionId).toBe("sub_m");
    // The next checkout reuses the Dodo customer.
    await db.exec(`update accounts set dodo_subscription_status = 'cancelled' where id = '${accountId}'`);
    await svc.startBillingMethod(deps(), accountId);
    expect(dodo.checkouts[1]!.customer).toEqual({ customerId: "cus_dodo_1" });
  });

  it("ignores subscriptions for another product or another account, and stale events", async () => {
    const { accountId } = await addFounder(db, { stripe: "acct_n" });
    const other = await addFounder(db, { stripe: "acct_o" });
    const foreign = dodo.subscription("sub_pixel", accountId, { product_id: "pdt_other" });
    expect(await svc.handleDodoEvent(deps(), { type: "subscription.active", timestamp: clock.toISOString(), data: rawSub(foreign) })).toBe("ignored");
    // The return page only adopts a subscription that names THIS account.
    dodo.subscription("sub_theirs", other.accountId);
    expect(await svc.confirmReturn(deps(), accountId, "sub_theirs")).toBe(false);
    expect(await db.value("select dodo_subscription_id from accounts where id = $1", [accountId])).toBeNull();

    const mine = dodo.subscription("sub_mine", accountId);
    expect(await svc.confirmReturn(deps(), accountId, "sub_mine")).toBe(true);
    // An older on_hold event arriving late doesn't overwrite the newer active state.
    const older = new Date(clock.getTime() - 60_000).toISOString();
    expect(await svc.handleDodoEvent(deps(), { type: "subscription.on_hold", timestamp: older, data: rawSub({ ...mine, status: "on_hold" }) })).toBe("ignored");
    expect(await db.value("select dodo_subscription_status from accounts where id = $1", [accountId])).toBe("active");
    // A newer cancellation does.
    clock = new Date(clock.getTime() + 60_000);
    await svc.handleDodoEvent(deps(), { type: "subscription.cancelled", timestamp: clock.toISOString(), data: rawSub({ ...mine, status: "cancelled" }) });
    expect(await db.query("select dodo_subscription_status, billing_pm_status from accounts where id = $1", [accountId])).toEqual([
      { dodo_subscription_status: "cancelled", billing_pm_status: "none" },
    ]);
  });
});

describe("monthly charge amounts", () => {
  it("charges fees after clawbacks with the $299 cap, in USD cents, once", async () => {
    const { accountId, subscriptionId } = await founderWithCard();
    for (let i = 0; i < 20; i++) await fee(accountId, "2026-09-01", 2_000); // $400 of fees
    await fee(accountId, "2026-09-01", 5_000, 5_000); // fully clawed back
    await fee(accountId, "2026-10-01", 1_000); // this month: not yet

    const { statements, charged } = await monthlyRun();
    expect(statements).toMatchObject({ month: "2026-09-01", closed: 1 });
    expect(charged).toMatchObject({ due: 1, sent: 1 });
    expect(dodo.charges).toEqual([
      expect.objectContaining({
        subscriptionId,
        amountCents: 29_900,
        description: "Unquit fees, September 2026",
        metadata: expect.objectContaining({ unquit_account_id: accountId, unquit_period: "2026-09", retry_attempt: "0" }),
      }),
    ]);
    expect(await period(accountId, "2026-09-01")).toMatchObject({ status: "closed", gross_cents: 40_000, cap_discount_cents: 10_100, total_cents: 29_900, amount_due_cents: 29_900, payment_status: "processing" });

    // The cron fires again (a retry, or the daily catch-up): nothing more is charged.
    expect(await monthlyRun()).toMatchObject({ statements: { already_done: 1 }, charged: { due: 0 } });
    expect(dodo.charges).toHaveLength(1);
    expect(await charges(accountId)).toHaveLength(1);
  });

  it("nets partial clawbacks and leaves $0 months uncharged", async () => {
    const a = await founderWithCard("a");
    await fee(a.accountId, "2026-09-01", 5_000, 2_000);
    const b = await founderWithCard("b");
    await fee(b.accountId, "2026-09-01", 900, 900);
    await monthlyRun();
    expect(dodo.charges.map((c) => [c.metadata.unquit_account_id, c.amountCents])).toEqual([[a.accountId, 3_000]]);
    expect(await period(b.accountId, "2026-09-01")).toMatchObject({ status: "zero", amount_due_cents: 0, payment_status: null });
    expect(await charges(b.accountId)).toHaveLength(0);
  });

  it("carries amounts under $1 forward and adds them to the next statement", async () => {
    const { accountId } = await founderWithCard();
    await fee(accountId, "2026-09-01", 60);
    await monthlyRun();
    expect(dodo.charges).toHaveLength(0);
    const sept = await period(accountId, "2026-09-01");
    expect(sept).toMatchObject({ status: "closed", payment_status: "carried_forward", amount_due_cents: 60 });

    await fee(accountId, "2026-10-01", 80);
    clock = NOV_1;
    await monthlyRun();
    const oct = await period(accountId, "2026-10-01");
    expect(oct).toMatchObject({ total_cents: 80, carried_in_cents: 60, amount_due_cents: 140, payment_status: "processing" });
    expect(await period(accountId, "2026-09-01")).toMatchObject({ carried_to_period_id: oct.id });
    expect(dodo.charges.map((c) => c.amountCents)).toEqual([140]);

    // Re-running November's close doesn't carry September twice.
    expect(await svc.claimCarryIn(db, accountId, String(oct.id))).toBe(60);
  });

  it("carries a credit bigger than the month's fees forward and never pays out", async () => {
    const { accountId, subscriptionId } = await founderWithCard();
    const sepLine = await fee(accountId, "2026-09-01", 2_000);
    await monthlyRun();
    await webhookPayment(dodo.charges[0]!.paymentId!, "succeeded");
    expect((await charges(accountId))[0]!.status).toBe("paid");

    // October: September's fee is clawed back in full ($20 credit) and October only earns $5.
    await db.query("update save_fee_lines set clawed_back_cents = amount_cents where id = $1", [sepLine]);
    await fee(accountId, "2026-10-01", 500);
    clock = NOV_1;
    await monthlyRun();
    expect(await period(accountId, "2026-10-01")).toMatchObject({ status: "zero", capped_cents: 500, credit_applied_cents: 500, total_cents: 0, amount_due_cents: 0 });
    expect(dodo.charges).toHaveLength(1);

    // November earns $30: the remaining $15 of credit comes off.
    await fee(accountId, "2026-11-01", 3_000);
    clock = DEC_1;
    await monthlyRun();
    expect(dodo.charges.map((c) => [c.subscriptionId, c.amountCents])).toEqual([
      [subscriptionId, 2_000],
      [subscriptionId, 1_500],
    ]);
    expect(dodo.charges.every((c) => c.amountCents > 0)).toBe(true);
  });
});

describe("idempotency", () => {
  it("overlapping runs send one charge", async () => {
    const { accountId } = await founderWithCard();
    await fee(accountId, "2026-09-01", 2_000);
    await runMonthlyBilling(billing());
    const runs = await Promise.all([svc.chargeDue(deps()), svc.chargeDue(deps()), svc.chargeDue(deps())]);
    expect(dodo.charges).toHaveLength(1);
    expect(runs.reduce((n, r) => n + (r.sent ?? 0), 0)).toBe(1);
    expect(await db.count("billing_charge_attempts")).toBe(1);
  });

  it("a lost response is never re-sent: the payment is found by its metadata and settled", async () => {
    const { accountId } = await founderWithCard();
    await fee(accountId, "2026-09-01", 2_000);
    dodo.next({ kind: "lost_response" });
    const first = await monthlyRun();
    expect(first.charged).toMatchObject({ unknown: 1 });
    expect((await charges(accountId))[0]!.status).toBe("processing");

    // The cron retries minutes later: the attempt is in flight, nothing is sent.
    clock = new Date(OCT_1.getTime() + 5 * 60_000);
    await svc.chargeDue(deps());
    expect(dodo.charges).toHaveLength(1);

    // Later, reconciliation finds Dodo's payment by unquit_attempt_id and adopts it.
    clock = new Date(OCT_1.getTime() + 20 * 60_000);
    const paymentId = dodo.charges[0]!.paymentId!;
    dodo.settle(paymentId, "succeeded");
    expect((await svc.chargeDue(deps())).reconciled).toBe(1);
    const [charge] = await charges(accountId);
    expect(charge).toMatchObject({ status: "paid", dodo_payment_id: paymentId, receipt_url: `https://test.dodopayments.com/invoices/payments/${paymentId}` });
    expect(dodo.charges).toHaveLength(1);
    // The late webhook is a no-op.
    expect(await webhookPayment(paymentId, "succeeded")).toBe("processed");
    expect(await db.count("billing_charge_attempts", "state = 'succeeded'")).toBe(1);
  });

  it("a request that never reached Dodo becomes a soft failure an hour later and follows the schedule", async () => {
    const { accountId } = await founderWithCard();
    await fee(accountId, "2026-09-01", 2_000);
    dodo.next({ kind: "network_error" });
    await monthlyRun();
    clock = new Date(OCT_1.getTime() + 61 * 60_000);
    await svc.chargeDue(deps());
    const [charge] = await charges(accountId);
    expect(charge).toMatchObject({ status: "retrying", last_error_code: "NOT_CREATED", attempts_count: 1 });
    expect(new Date(charge!.next_attempt_at!).toISOString()).toBe(new Date(OCT_1.getTime() + 3 * DAY).toISOString());
    expect(dodo.charges).toHaveLength(1);
  });
});

describe("webhooks", () => {
  it("are de-duplicated by webhook-id; a failed delivery may be processed again", async () => {
    const now = clock;
    expect(await svc.claimWebhook(db, "msg_1", "payment.succeeded", "pay_1", now)).toBe("new");
    expect(await svc.claimWebhook(db, "msg_1", "payment.succeeded", "pay_1", now)).toBe("in_progress");
    await svc.finishWebhook(db, "msg_1", "processed", now);
    expect(await svc.claimWebhook(db, "msg_1", "payment.succeeded", "pay_1", now)).toBe("duplicate");

    expect(await svc.claimWebhook(db, "msg_2", "payment.failed", "pay_2", now)).toBe("new");
    await svc.finishWebhook(db, "msg_2", "failed", now, "boom");
    expect(await svc.claimWebhook(db, "msg_2", "payment.failed", "pay_2", now)).toBe("new");
  });

  it("mark statements paid with Dodo's receipt, ignore payments that aren't unquit's, and record refunds once", async () => {
    const { accountId } = await founderWithCard();
    await fee(accountId, "2026-09-01", 2_000);
    await monthlyRun();
    const paymentId = dodo.charges[0]!.paymentId!;
    // Someone else's payment on the same Dodo business, and a card-update payment: ignored.
    expect(await svc.handleDodoEvent(deps(), { type: "payment.succeeded", data: { payment_id: "pay_pixel_paper", status: "succeeded", metadata: {} } })).toBe("ignored");
    expect(await svc.handleDodoEvent(deps(), { type: "payment.succeeded", data: { payment_id: "pay_upd", is_update_payment_method: true, metadata: {} } })).toBe("ignored");

    expect(await webhookPayment(paymentId, "succeeded")).toBe("processed");
    expect(await period(accountId, "2026-09-01")).toMatchObject({ payment_status: "paid" });

    const refund = { refund_id: "ref_1", payment_id: paymentId, amount: 500, currency: "USD", status: "succeeded" };
    expect(await svc.handleDodoEvent(deps(), { type: "refund.succeeded", data: refund })).toBe("processed");
    expect(await svc.handleDodoEvent(deps(), { type: "refund.succeeded", data: refund })).toBe("processed"); // replay
    expect((await charges(accountId))[0]).toMatchObject({ status: "partially_refunded", refunded_cents: 500 });
    await svc.handleDodoEvent(deps(), { type: "refund.succeeded", data: { ...refund, refund_id: "ref_2", amount: 1_500 } });
    expect((await charges(accountId))[0]).toMatchObject({ status: "refunded", refunded_cents: 2_000 });
    expect(await period(accountId, "2026-09-01")).toMatchObject({ payment_status: "refunded" });
  });
});

describe("failures: Dodo's safe retry policy", () => {
  it("retries a soft decline at +3, +10 and +17 days at the same time of day, then marks the statement unpaid and emails", async () => {
    const { accountId } = await founderWithCard();
    await fee(accountId, "2026-09-01", 2_000);
    await monthlyRun();
    const expectNext = async (days: number) =>
      expect(new Date((await charges(accountId))[0]!.next_attempt_at!).toISOString()).toBe(new Date(OCT_1.getTime() + days * DAY).toISOString());

    await webhookPayment(dodo.charges[0]!.paymentId!, "failed", { error_code: "INSUFFICIENT_FUNDS", error_message: "no funds" });
    expect((await charges(accountId))[0]).toMatchObject({ status: "retrying", last_error_code: "INSUFFICIENT_FUNDS" });
    await expectNext(3);
    expect(mail.map((m) => m.subject)).toEqual(["Your unquit payment of $20.00 didn't go through"]);

    // Not due yet on day 1 and 2.
    clock = new Date(OCT_1.getTime() + 1 * DAY);
    await svc.chargeDue(deps());
    clock = new Date(OCT_1.getTime() + 2 * DAY);
    await svc.chargeDue(deps());
    expect(dodo.charges).toHaveLength(1);

    for (const [day, nextDay] of [
      [3, 10],
      [10, 17],
    ] as const) {
      // The daily cron runs at 06:00 UTC, a few seconds early is fine.
      clock = new Date(OCT_1.getTime() + day * DAY - 30_000);
      expect(await svc.chargeDue(deps())).toMatchObject({ sent: 1 });
      const last = dodo.charges.at(-1)!;
      expect(last.metadata.retry_attempt).toBe(String(dodo.charges.length - 1));
      await webhookPayment(last.paymentId!, "failed", { error_code: "GENERIC_DECLINE" });
      await expectNext(nextDay);
    }

    clock = new Date(OCT_1.getTime() + 17 * DAY);
    await svc.chargeDue(deps());
    expect(dodo.charges).toHaveLength(4);
    await webhookPayment(dodo.charges[3]!.paymentId!, "failed", { error_code: "INSUFFICIENT_FUNDS" });
    expect((await charges(accountId))[0]).toMatchObject({ status: "unpaid", attempts_count: 4, next_attempt_at: null, hard_declined: false });
    expect(await period(accountId, "2026-09-01")).toMatchObject({ payment_status: "unpaid" });
    expect(await svc.hasUnpaidStatement(db, accountId)).toBe(true);
    expect(mail.map((m) => m.subject)).toEqual([
      "Your unquit payment of $20.00 didn't go through",
      "Action needed: update your card for unquit ($20.00 unpaid)",
    ]);

    // Nothing more is attempted, however often the cron runs.
    clock = new Date(OCT_1.getTime() + 30 * DAY);
    await svc.chargeDue(deps());
    expect(dodo.charges).toHaveLength(4);
  });

  it("never retries a hard decline; a new card starts one fresh cycle", async () => {
    const { accountId, subscriptionId } = await founderWithCard();
    await fee(accountId, "2026-09-01", 2_000);
    await monthlyRun();
    await webhookPayment(dodo.charges[0]!.paymentId!, "failed", { error_code: "STOLEN_CARD" });
    expect((await charges(accountId))[0]).toMatchObject({ status: "unpaid", hard_declined: true, attempts_count: 1 });
    expect(mail.at(-1)!.subject).toMatch(/Action needed/);
    // Dodo's real reason is never shown to the founder.
    clock = new Date(OCT_1.getTime() + 3 * DAY);
    await svc.chargeDue(deps());
    expect(dodo.charges).toHaveLength(1);

    // The founder updates their card: subscription.active again.
    clock = new Date(OCT_1.getTime() + 4 * DAY);
    const sub = dodo.subscriptions.get(subscriptionId)!;
    await svc.handleDodoEvent(deps(), { type: "subscription.active", timestamp: clock.toISOString(), data: rawSub({ ...sub, payment_method_id: "pm_2" }) });
    expect((await charges(accountId))[0]).toMatchObject({ status: "scheduled", cycle_attempts: 0, hard_declined: false });
    await svc.chargeDue(deps());
    expect(dodo.charges).toHaveLength(2);
    await webhookPayment(dodo.charges[1]!.paymentId!, "succeeded");
    expect((await charges(accountId))[0]).toMatchObject({ status: "paid", attempts_count: 2 });
    expect(await svc.hasUnpaidStatement(db, accountId)).toBe(false);
  });

  it("treats an API refusal (no payment created) like a decline, and stops at 429", async () => {
    const { accountId } = await founderWithCard();
    await fee(accountId, "2026-09-01", 2_000);
    dodo.next({ kind: "api_error", status: 429 });
    const { charged } = await monthlyRun();
    expect(charged).toMatchObject({ failed: 1 });
    expect((await charges(accountId))[0]).toMatchObject({ status: "unpaid", last_error_code: "TOO_MANY_FAILED_PAYMENTS" });
  });

  it("waits for a card when there is none, emails once, and charges after the card is added", async () => {
    const { accountId } = await addFounder(db, { stripe: "acct_nocard" });
    await fee(accountId, "2026-09-01", 2_000);
    const { charged } = await monthlyRun();
    expect(charged).toMatchObject({ awaiting_card: 1 });
    expect(dodo.charges).toHaveLength(0);
    expect(mail.map((m) => m.subject)).toEqual(["Add a card to pay your unquit statement ($20.00)"]);
    await svc.chargeDue(deps());
    expect(mail).toHaveLength(1);

    clock = new Date(OCT_1.getTime() + 2 * DAY);
    const sub = dodo.subscription("sub_late", accountId);
    await svc.handleDodoEvent(deps(), { type: "subscription.active", timestamp: clock.toISOString(), data: rawSub(sub) });
    expect(await svc.chargeDue(deps())).toMatchObject({ sent: 1 });
    expect(dodo.charges[0]).toMatchObject({ subscriptionId: "sub_late", amountCents: 2_000 });
  });
});
