/**
 * Unpaid bill -> warning -> 3-day grace -> pause -> auto-resume on payment,
 * end to end against Postgres (PGlite + every migration) and a fake Dodo.
 * Decided by Saurav 2026-10-14 (lib/billing/pause.ts).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { addFounder, createTestDb, type TestDb } from "@/lib/db/testing/pglite";
import { fakeDodo, type FakeDodo } from "./dodo/testing";

vi.mock("server-only", () => ({}));
const { createBillingRepo } = await import("@/lib/billing/repo");
const { runMonthlyBilling } = await import("@/lib/billing/service");
const svc = await import("./dodo/service");
const pause = await import("./pause");
const { MIN_CHARGE_CENTS } = await import("./dodo/policy");

const DAY = 86_400_000;
const OCT_1 = new Date(Date.UTC(2026, 9, 1, 6, 0, 0));

let db: TestDb;
let dodo: FakeDodo;
let clock: Date;
let mail: { accountId: string; subject: string; key: string; text: string }[];
let mailerMode: "ok" | "throws" | "none";
let seq = 0;

beforeEach(async () => {
  db = await createTestDb();
  dodo = fakeDodo({ productId: "pdt_usage" });
  clock = OCT_1;
  mail = [];
  mailerMode = "ok";
}, 60_000);

function deps(): import("./dodo/service").DodoBillingDeps {
  return {
    db,
    dodo: dodo.client,
    productId: dodo.productId,
    appUrl: "https://app.unquit.test",
    now: () => clock,
    mailer:
      mailerMode === "none"
        ? undefined
        : {
            async toFounder(accountId, email) {
              if (mailerMode === "throws") throw new Error("RESEND_API_KEY is not set");
              mail.push({ accountId, subject: email.subject, key: email.idempotencyKey, text: email.text });
              return true;
            },
          },
  };
}

async function fee(accountId: string, month: string, cents: number) {
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
  await db.exec(
    `insert into save_fee_lines (save_id, account_id, month_index, billing_month, stripe_invoice_id, amount_cents, invoice_amount_paid_cents)
     values ('${saveId}', '${accountId}', 1, '${month}', 'in_${seq}', ${cents}, ${cents * 10})`,
  );
}

function rawSub(sub: import("./dodo/client").DodoSubscription): Record<string, unknown> {
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

async function founderWithCard() {
  const { accountId } = await addFounder(db, { stripe: `acct_p_${++seq}` });
  const sub = dodo.subscription(`sub_p_${seq}`, accountId);
  dodo.paymentMethods.set("cus_dodo_1", [{ payment_method_id: "pm_1", brand: "VISA", last4: "4242" }]);
  await svc.handleDodoEvent(deps(), { type: "subscription.active", timestamp: new Date(clock.getTime() - DAY).toISOString(), data: rawSub(sub) });
  return { accountId, subscriptionId: sub.subscription_id };
}

async function webhookPayment(paymentId: string, status: "succeeded" | "failed", fields: Partial<import("./dodo/client").DodoPayment> = {}) {
  const p = dodo.settle(paymentId, status, fields);
  return svc.handleDodoEvent(deps(), { type: `payment.${status}`, timestamp: clock.toISOString(), data: { ...p, customer: { customer_id: p.customer_id } } });
}

async function monthlyRun() {
  await runMonthlyBilling({
    repo: createBillingRepo(db),
    appUrl: "https://app.unquit.test",
    now: () => clock,
    collector: {
      minChargeCents: MIN_CHARGE_CENTS,
      claimCarryIn: (a, p) => svc.claimCarryIn(db, a, p),
      scheduleCharge: (input) => svc.scheduleCharge(db, input),
    },
  });
  await svc.chargeDue(deps());
}

const state = (accountId: string) => pause.loadPause(db, accountId);

/** A founder whose September statement ($20) was hard-declined: unpaid at once. */
async function unpaidFounder() {
  const f = await founderWithCard();
  await fee(f.accountId, "2026-09-01", 2_000);
  await monthlyRun();
  await webhookPayment(dodo.charges[0]!.paymentId!, "failed", { error_code: "STOLEN_CARD" });
  return f;
}

describe("the pause decision (pure)", () => {
  const now = new Date("2026-10-10T06:00:00Z");
  const unpaid = { status: "unpaid", unpaid_at: "2026-10-04T06:00:00Z" };
  const base = { billing_pause_source: null, billing_pause_due_at: null, billing_resumed_at: null } as const;

  it("warns an active account with an unpaid charge (once per unpaid since the last resume)", () => {
    expect(pause.decideSweep({ ...base, billing_pause_state: "active" }, [unpaid], now)).toBe("warn");
    expect(pause.decideSweep({ ...base, billing_pause_state: "active" }, [], now)).toBe("none");
    expect(pause.decideSweep({ ...base, billing_pause_state: "active", billing_resumed_at: "2026-10-05T00:00:00Z" }, [unpaid], now)).toBe("none");
  });

  it("pauses a warned account only once the 3 days are up, still owing, and nothing in flight", () => {
    const warned = { ...base, billing_pause_state: "warned" as const, billing_pause_due_at: "2026-10-12T06:00:00Z" };
    expect(pause.decideSweep(warned, [unpaid], now)).toBe("none");
    expect(pause.decideSweep(warned, [unpaid], new Date("2026-10-12T05:30:00Z"))).toBe("pause"); // the 06:00 cron, a little early
    expect(pause.decideSweep(warned, [{ ...unpaid, status: "processing" }], new Date("2026-10-13T06:00:00Z"))).toBe("none");
    expect(pause.decideSweep(warned, [], now)).toBe("clear_warning");
  });

  it("resumes an automatic pause once nothing is owed, never an admin pause", () => {
    expect(pause.decideSweep({ ...base, billing_pause_state: "paused", billing_pause_source: "auto" }, [], now)).toBe("resume");
    expect(pause.decideSweep({ ...base, billing_pause_state: "paused", billing_pause_source: "auto" }, [unpaid], now)).toBe("none");
    expect(pause.decideSweep({ ...base, billing_pause_state: "paused", billing_pause_source: "admin" }, [], now)).toBe("none");
  });

  it("gives a 3-day grace period", () => {
    expect(pause.pauseDueAt(now).toISOString()).toBe("2026-10-13T06:00:00.000Z");
    expect(pause.PAUSE_GRACE_DAYS).toBe(3);
  });
});

describe("unpaid -> warned -> paused -> resumed", () => {
  it("warns at once when the statement goes unpaid, with an update-card link", async () => {
    const { accountId } = await unpaidFounder();
    const row = await state(accountId);
    expect(row).toMatchObject({ billing_pause_state: "warned" });
    expect(new Date(row!.billing_pause_due_at!).getTime() - new Date(row!.billing_pause_warned_at!).getTime()).toBe(3 * DAY);
    expect(row!.billing_pause_warning_emailed_at).not.toBeNull();
    const warning = mail.at(-1)!;
    expect(warning.subject).toBe("Action needed: unquit will pause in 3 days unless you update your card ($20.00 unpaid)");
    expect(warning.text).toContain("Unquit will pause on October 4, 2026 unless the card is updated");
    expect(warning.text).toContain("https://app.unquit.test/dashboard/billing");
    expect(await pause.isAccountPaused(db, accountId)).toBe(false);
  });

  it("also warns after the final (+17 day) retry of a soft decline", async () => {
    const { accountId } = await founderWithCard();
    await fee(accountId, "2026-09-01", 2_000);
    await monthlyRun();
    await webhookPayment(dodo.charges[0]!.paymentId!, "failed", { error_code: "INSUFFICIENT_FUNDS" });
    for (const day of [3, 10, 17]) {
      expect((await state(accountId))!.billing_pause_state).toBe("active"); // still retrying: no warning yet
      clock = new Date(OCT_1.getTime() + day * DAY);
      await svc.chargeDue(deps());
      await webhookPayment(dodo.charges.at(-1)!.paymentId!, "failed", { error_code: "INSUFFICIENT_FUNDS" });
    }
    expect((await state(accountId))!.billing_pause_state).toBe("warned");
  });

  it("pauses after the 3-day grace (not before), emails once, and keeps sweeping idempotent", async () => {
    const { accountId } = await unpaidFounder();
    clock = new Date(OCT_1.getTime() + 2 * DAY);
    expect(await pause.runPauseSweep(deps())).toMatchObject({ paused: 0 });
    expect(await pause.isAccountPaused(db, accountId)).toBe(false);

    clock = new Date(OCT_1.getTime() + 3 * DAY);
    expect(await pause.runPauseSweep(deps())).toMatchObject({ paused: 1 });
    expect(await state(accountId)).toMatchObject({ billing_pause_state: "paused", billing_pause_source: "auto" });
    expect(await pause.isAccountPaused(db, accountId)).toBe(true);
    expect(mail.at(-1)!.subject).toBe("Unquit is paused: update your card to resume");
    expect(mail.at(-1)!.text).toContain("Your customers can still cancel");

    const sent = mail.length;
    expect(await pause.runPauseSweep(deps())).toMatchObject({ paused: 0, resumed: 0 });
    clock = new Date(OCT_1.getTime() + 4 * DAY);
    await pause.runPauseSweep(deps());
    expect(mail).toHaveLength(sent);
    expect(await pause.pauseBannerFor(db, accountId)).toEqual({ state: "paused", byAdmin: false });
  });

  it("a card update charges straight away; payment.succeeded resumes the account and emails", async () => {
    const { accountId, subscriptionId } = await unpaidFounder();
    clock = new Date(OCT_1.getTime() + 3 * DAY);
    await pause.runPauseSweep(deps());
    expect(await pause.isAccountPaused(db, accountId)).toBe(true);

    clock = new Date(OCT_1.getTime() + 5 * DAY);
    const sub = dodo.subscriptions.get(subscriptionId)!;
    await svc.handleDodoEvent(deps(), { type: "subscription.active", timestamp: clock.toISOString(), data: rawSub({ ...sub, payment_method_id: "pm_2" }) });
    expect(dodo.charges).toHaveLength(2); // charged immediately, no waiting for the daily cron
    expect(await pause.isAccountPaused(db, accountId)).toBe(true); // not until the payment succeeds

    // A sweep while the payment is in flight neither resumes nor re-pauses.
    expect(await pause.runPauseSweep(deps())).toMatchObject({ resumed: 0, paused: 0 });

    await webhookPayment(dodo.charges[1]!.paymentId!, "succeeded");
    expect(await state(accountId)).toMatchObject({ billing_pause_state: "active", billing_pause_source: null });
    expect((await state(accountId))!.billing_resumed_at).not.toBeNull();
    expect(mail.at(-1)!.subject).toBe("Unquit is back on");
    expect(await pause.pauseBannerFor(db, accountId)).toBeNull();

    // A re-delivered success changes nothing and sends nothing.
    const sent = mail.length;
    await svc.handleDodoEvent(deps(), { type: "payment.succeeded", timestamp: clock.toISOString(), data: { ...dodo.payments.get(dodo.charges[1]!.paymentId!)!, customer: {} } });
    expect(mail).toHaveLength(sent);
  });

  it("paying during the warning clears it without ever pausing", async () => {
    const { accountId, subscriptionId } = await unpaidFounder();
    clock = new Date(OCT_1.getTime() + 1 * DAY);
    const sub = dodo.subscriptions.get(subscriptionId)!;
    await svc.handleDodoEvent(deps(), { type: "subscription.updated", timestamp: clock.toISOString(), data: rawSub({ ...sub, payment_method_id: "pm_3" }) });
    await webhookPayment(dodo.charges.at(-1)!.paymentId!, "succeeded");
    expect((await state(accountId))!.billing_pause_state).toBe("active");
    expect(mail.map((m) => m.subject)).not.toContain("Unquit is back on");
    clock = new Date(OCT_1.getTime() + 4 * DAY);
    expect(await pause.runPauseSweep(deps())).toMatchObject({ paused: 0 });
  });

  it("the sweep resumes an auto-paused account whose payment webhook was missed", async () => {
    const { accountId } = await unpaidFounder();
    clock = new Date(OCT_1.getTime() + 3 * DAY);
    await pause.runPauseSweep(deps());
    await db.exec(`update billing_charges set status = 'paid', paid_at = now() where account_id = '${accountId}'`);
    expect(await pause.runPauseSweep(deps())).toMatchObject({ resumed: 1 });
    expect(await pause.isAccountPaused(db, accountId)).toBe(false);
  });

  it("the sweep starts a warning a crash skipped", async () => {
    const { accountId } = await unpaidFounder();
    await db.exec(
      `update accounts set billing_pause_state = 'active', billing_pause_warned_at = null, billing_pause_due_at = null where id = '${accountId}'`,
    );
    expect(await pause.runPauseSweep(deps())).toMatchObject({ warned: 1 });
    expect((await state(accountId))!.billing_pause_state).toBe("warned");
    expect(await pause.runPauseSweep(deps())).toMatchObject({ warned: 0 });
  });
});

describe("admin pause and resume", () => {
  it("an admin pause is not lifted by a payment; an admin resume lifts it", async () => {
    const { accountId } = await founderWithCard();
    expect(await pause.pauseAccount(deps(), accountId, "admin")).toBe(true);
    expect(await pause.pauseAccount(deps(), accountId, "admin")).toBe(false); // idempotent
    expect(await state(accountId)).toMatchObject({ billing_pause_state: "paused", billing_pause_source: "admin" });
    expect(mail.at(-1)!.text).toContain("paused by the Unquit team");

    expect(await pause.resumeIfSettled(deps(), accountId)).toBe(false);
    expect(await pause.runPauseSweep(deps())).toMatchObject({ resumed: 0 });
    expect(await pause.isAccountPaused(db, accountId)).toBe(true);

    expect(await pause.resumeAccount(deps(), accountId, "admin")).toBe(true);
    expect(await pause.resumeAccount(deps(), accountId, "admin")).toBe(false);
    expect(await pause.isAccountPaused(db, accountId)).toBe(false);
    expect(mail.at(-1)!.subject).toBe("Unquit is back on");
  });

  it("an admin resume while still owing holds until a NEW statement goes unpaid", async () => {
    const { accountId } = await unpaidFounder();
    clock = new Date(OCT_1.getTime() + 3 * DAY);
    await pause.runPauseSweep(deps());
    clock = new Date(OCT_1.getTime() + 4 * DAY);
    expect(await pause.resumeAccount(deps(), accountId, "admin")).toBe(true);
    clock = new Date(OCT_1.getTime() + 8 * DAY);
    expect(await pause.runPauseSweep(deps())).toMatchObject({ warned: 0, paused: 0 });
    expect((await state(accountId))!.billing_pause_state).toBe("active");
  });

  it("finds an account by id or owner email", async () => {
    const { accountId } = await addFounder(db, { email: "owner@example.com", stripe: "acct_find" });
    expect(await pause.findAccountForAdmin(db, accountId)).toBe(accountId);
    expect(await pause.findAccountForAdmin(db, "Owner@Example.com")).toBe(accountId);
    expect(await pause.findAccountForAdmin(db, "nobody@example.com")).toBeNull();
    expect(await pause.findAccountForAdmin(db, "garbage")).toBeNull();
  });

  it("lists warned and paused accounts with what they owe", async () => {
    const { accountId } = await unpaidFounder();
    const rows = await pause.adminPauses(db);
    expect(rows).toEqual([expect.objectContaining({ id: accountId, billing_pause_state: "warned", outstanding_cents: 2_000 })]);
  });
});

describe("emails are never fatal", () => {
  it("works the same with no mailer (no Resend) and with a mailer that throws", async () => {
    for (const mode of ["none", "throws"] as const) {
      mailerMode = mode;
      clock = OCT_1;
      const before = dodo.charges.length;
      const { accountId, subscriptionId } = await founderWithCard();
      await fee(accountId, "2026-09-01", 2_000);
      await monthlyRun();
      await webhookPayment(dodo.charges[before]!.paymentId!, "failed", { error_code: "STOLEN_CARD" });
      expect(await state(accountId)).toMatchObject({ billing_pause_state: "warned", billing_pause_warning_emailed_at: null });
      clock = new Date(OCT_1.getTime() + 3 * DAY);
      await pause.runPauseSweep(deps());
      expect(await state(accountId)).toMatchObject({ billing_pause_state: "paused", billing_pause_emailed_at: null });
      const sub = dodo.subscriptions.get(subscriptionId)!;
      await svc.handleDodoEvent(deps(), { type: "subscription.active", timestamp: clock.toISOString(), data: rawSub({ ...sub, payment_method_id: `pm_${mode}` }) });
      await webhookPayment(dodo.charges.at(-1)!.paymentId!, "succeeded");
      expect(await state(accountId)).toMatchObject({ billing_pause_state: "active", billing_resume_emailed_at: null });
    }
    expect(mail).toEqual([]);
  });
});

describe("schema 0011", () => {
  it("keeps pause state consistent and accepts the overlap columns and event", async () => {
    const { accountId } = await addFounder(db, { stripe: "acct_schema" });
    expect(await db.fails(`update accounts set billing_pause_state = 'bogus' where id = '${accountId}'`)).toBe(true);
    expect(await db.fails(`update accounts set billing_pause_state = 'paused' where id = '${accountId}'`)).toBe(true); // no paused_at / source
    expect(await db.fails(`update accounts set billing_pause_state = 'warned' where id = '${accountId}'`)).toBe(true); // no due date
    expect(await db.fails(`update accounts set billing_pause_source = 'someone' where id = '${accountId}'`)).toBe(true);

    await fee(accountId, "2026-09-01", 700);
    const lineId = await db.value<string>(`select id from save_fee_lines where account_id = $1`, [accountId]);
    const saveId = await db.value<string>(`select save_id from save_fee_lines where id = $1`, [lineId]);
    expect(await db.fails(`update save_fee_lines set overlap_save_id = '${saveId}' where id = '${lineId}'`)).toBe(true); // needs the timestamp too
    await db.exec(`insert into save_events (account_id, save_id, kind) values ('${accountId}', '${saveId}', 'overlap_reduced')`);

    // The ledger repo's compare-and-set reduction.
    const { createLedgerRepo } = await import("@/lib/ledger/repo");
    const repo = createLedgerRepo(db);
    expect(await repo.reduceLineForOverlap(lineId, { amountCents: 350, overlapSaveId: saveId, at: OCT_1.toISOString() })).toBe(true);
    expect(await repo.reduceLineForOverlap(lineId, { amountCents: 100, overlapSaveId: saveId, at: OCT_1.toISOString() })).toBe(false);
    const line = (await repo.linesForInvoice(accountId, `in_${seq}`))[0]!;
    expect(line).toMatchObject({ amount_cents: 350, overlap_save_id: saveId });
    // The statement reads it as an overlap line.
    const period = await db.value<string>(
      `insert into billing_periods (account_id, period_month, status) values ($1, '2026-09-01', 'building') returning id`,
      [accountId],
    );
    await db.exec(`update save_fee_lines set billing_period_id = '${period}' where id = '${lineId}'`);
    expect(await createBillingRepo(db).linesForPeriod(period)).toEqual([expect.objectContaining({ amountCents: 350, kind: "dunning", overlap: true })]);
  });
});
