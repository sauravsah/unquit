/**
 * Tenant isolation now lives in the query layer (there is no RLS): every
 * founder-facing loader is scoped by the signed-in founder's account id.
 * Two founders with the same kinds of data; A must only ever see A's.
 */
import { beforeAll, describe, expect, it, vi } from "vitest";
import { addFounder, createTestDb, type TestDb } from "@/lib/db/testing/pglite";

vi.mock("server-only", () => ({}));
const { findAccountForUser, getOrCreateAccount, getWidgetKeys, rotateWidgetSigningSecret } = await import("@/lib/accounts");
const { loadActivity } = await import("@/lib/activity");
const { loadAdminQueue } = await import("@/lib/admin");
const { loadBillingPage, loadStatement } = await import("@/lib/billing/dashboard");
const { loadDashboardData } = await import("@/lib/dashboard");
const { loadDunningDashboard } = await import("@/lib/dunning/dashboard");
const { loadLedger, loadRunningTotal } = await import("@/lib/ledger/dashboard");
const { loadReceipt } = await import("@/lib/ledger/receipt");
const { loadOverviewExtras } = await import("@/app/dashboard/_lib/overview");

type Seed = { accountId: string; userId: string; cancelReceipt: string; dunningReceipt: string; caseId: string; sessionId: string };

let db: TestDb;
let A: Seed;
let B: Seed;
const month = (() => {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-01`;
})();

async function seed(name: string, stripe: string, mrr: number): Promise<Seed> {
  const { accountId, userId } = await addFounder(db, { name, stripe });
  const sessionId = await db.value<string>(
    `insert into cancel_sessions (account_id, stripe_customer_id, stripe_subscription_id, offer_accepted, offer_accepted_at, status, reason, reason_label, mrr_at_start_cents)
     values ($1, 'cus_${name}', 'sub_${name}', true, now(), 'offer_accepted', 'too_expensive', 'Too expensive', $2) returning id`,
    [accountId, mrr],
  );
  const cancelSave = await db.query<{ id: string; receipt_number: string }>(
    `insert into saves (account_id, type, cancel_session_id, stripe_customer_id, stripe_subscription_id, saved_mrr_cents, status, verified_at, stripe_invoice_id, offer)
     values ($1, 'cancel', $2, 'cus_${name}', 'sub_${name}', $3, 'verified', now(), 'in_${name}', '{"type":"discount","percentOff":30,"months":3}') returning id, receipt_number`,
    [accountId, sessionId, mrr],
  );
  await db.query(
    `insert into save_fee_lines (save_id, account_id, month_index, billing_month, stripe_invoice_id, amount_cents, invoice_amount_paid_cents)
     values ($1, $2, 1, $3, 'in_${name}', $4, $5)`,
    [cancelSave[0]!.id, accountId, month, mrr / 5, mrr],
  );
  await db.query(`insert into save_events (account_id, save_id, kind, detail) values ($1, $2, 'verified', '{}')`, [accountId, cancelSave[0]!.id]);
  await db.query(`insert into subscriptions_cache (account_id, stripe_subscription_id, stripe_customer_id, status, mrr_cents, last_event_created_at)
     values ($1, 'sub_pd_${name}', 'cus_pd_${name}', 'past_due', $2, now())`, [accountId, mrr * 2]);
  const caseId = await db.value<string>(
    `insert into dunning_cases (account_id, stripe_invoice_id, stripe_customer_id, amount_due_cents, status, recovered_via, recovered_amount_cents, recovered_at, decline_category)
     values ($1, 'in_d_${name}', 'cus_d_${name}', $2, 'recovered', 'update_link', $2, now(), 'soft') returning id`,
    [accountId, mrr],
  );
  await db.query(`insert into dunning_emails (account_id, dunning_case_id, step, category, to_email, subject, status) values ($1, $2, 0, 'soft', 'c@x.com', 's', 'sent')`, [accountId, caseId]);
  const dunningSave = await db.query<{ id: string; receipt_number: string }>(
    `insert into saves (account_id, type, dunning_case_id, stripe_customer_id, stripe_invoice_id, recovered_amount_cents, fee_cents, status, verified_at, attributed_via)
     values ($1, 'dunning', $2, 'cus_d_${name}', 'in_d_${name}', $3, $4, 'verified', now(), 'update_link') returning id, receipt_number`,
    [accountId, caseId, mrr, mrr / 10],
  );
  await db.query(
    `insert into save_fee_lines (save_id, account_id, month_index, billing_month, stripe_invoice_id, amount_cents, invoice_amount_paid_cents)
     values ($1, $2, 1, $3, 'in_d_${name}', $4, $5)`,
    [dunningSave[0]!.id, accountId, month, mrr / 10, mrr],
  );
  await db.query(`insert into disputes (save_id, account_id, opened_by, reason) values ($1, $2, $3, 'please check')`, [cancelSave[0]!.id, accountId, userId]);
  await db.query(`insert into billing_periods (account_id, period_month, status) values ($1, '2026-01-01', 'zero')`, [accountId]);
  await db.query(`insert into dunning_settings (account_id, enabled, company_name) values ($1, true, $2)`, [accountId, `${name} Inc`]);
  return { accountId, userId, sessionId, caseId, cancelReceipt: cancelSave[0]!.receipt_number, dunningReceipt: dunningSave[0]!.receipt_number };
}

beforeAll(async () => {
  db = await createTestDb();
  A = await seed("A", "acct_A", 10_000);
  B = await seed("B", "acct_B", 50_000);
}, 60_000);

describe("tenant isolation in the query layer", () => {
  it("receipts: a founder can open their own, and another founder's is 'not found'", async () => {
    const own = await loadReceipt(db, A.accountId, A.cancelReceipt);
    expect(own?.save.receipt_number).toBe(A.cancelReceipt);
    expect(own?.lines).toHaveLength(1);
    expect(own?.events).toHaveLength(1);
    expect(own?.disputes).toHaveLength(1);
    expect(own?.session?.reason_label).toBe("Too expensive");
    expect(await loadReceipt(db, A.accountId, B.cancelReceipt)).toBeNull();
    expect(await loadReceipt(db, A.accountId, B.dunningReceipt)).toBeNull();
  });

  it("the ledger (and so its CSV export) lists only the founder's saves", async () => {
    const items = await loadLedger(db, A.accountId, { type: null, status: null, month: null });
    expect(items.map((i) => i.receipt_number).sort()).toEqual([A.cancelReceipt, A.dunningReceipt].sort());
    expect(items.every((i) => i.account_id === A.accountId)).toBe(true);
    expect(items.find((i) => i.type === "cancel")?.fee_months).toBe(1);
    const filtered = await loadLedger(db, A.accountId, { type: "dunning", status: "verified", month: month.slice(0, 7) });
    expect(filtered.map((i) => i.receipt_number)).toEqual([A.dunningReceipt]);
  });

  it("overview numbers count only the founder's own rows", async () => {
    const data = await loadDashboardData(db, A.accountId);
    expect(data.mrrAtRiskCents).toBe(20_000);
    expect(data.pastDueCount).toBe(1);
    expect(data.savedMrrCents).toBe(10_000);
    expect(data.recoveredCents).toBe(10_000);
    expect(data.saveRate).toBe(1);
    expect(data.cancelSessions.map((s) => s.id)).toEqual([A.sessionId]);
    expect(data.fees.grossCents).toBe(2_000 + 1_000);
    const extras = await loadOverviewExtras(db, A.accountId);
    expect(extras.reasons).toEqual([{ reason: "Too expensive", count: 1 }]);
    expect(extras.checklist).toEqual({ flowSaved: false, widgetUsed: true, dunningOn: true, firstSave: true });
  });

  it("the activity feed (polled every 10 s) shows only the founder's events", async () => {
    const items = await loadActivity(db, A.accountId);
    expect(items.length).toBeGreaterThan(0);
    const bItems = await loadActivity(db, B.accountId);
    const aIds = new Set(items.map((i) => i.id));
    expect(bItems.some((i) => aIds.has(i.id))).toBe(false);
  });

  it("the dunning tab shows only the founder's cases, emails and fees", async () => {
    const d = await loadDunningDashboard(db, A.accountId);
    expect(d.cases.map((c) => c.id)).toEqual([A.caseId]);
    expect(d.cases[0]!.emails).toHaveLength(1);
    expect(d.cases[0]!.feeCents).toBe(1_000);
    expect(d.recoveredByUnquitThisMonthCents).toBe(10_000);
    expect(d.dunningFeesThisMonthCents).toBe(1_000);
    expect(d.settings.companyName).toBe("A Inc");
  });

  it("billing pages and the running total use only the founder's statements and fee lines", async () => {
    const page = await loadBillingPage(db, A.accountId);
    expect(page.periods).toHaveLength(1);
    expect(page.periods.every((p) => p.account_id === A.accountId)).toBe(true);
    const statement = await loadStatement(db, A.accountId, month);
    expect(statement.period).toBeNull();
    expect(statement.lines.map((l) => l.saves?.receipt_number).sort()).toEqual([A.cancelReceipt, A.dunningReceipt].sort());
    const running = await loadRunningTotal(db, A.accountId);
    expect(running.grossCents).toBe(3_000);
  });

  it("rotating the widget secret only touches the founder's own account", async () => {
    const before = { a: await getWidgetKeys(db, A.accountId), b: await getWidgetKeys(db, B.accountId) };
    expect(await rotateWidgetSigningSecret(db, A.accountId)).toBe(true);
    const after = { a: await getWidgetKeys(db, A.accountId), b: await getWidgetKeys(db, B.accountId) };
    expect(after.a.widget_signing_secret).not.toBe(before.a.widget_signing_secret);
    expect(after.a.widget_publishable_key).toBe(before.a.widget_publishable_key);
    expect(after.b).toEqual(before.b);
  });

  it("accounts are found and created by the session's user id only", async () => {
    expect((await findAccountForUser(db, A.userId))?.id).toBe(A.accountId);
    expect((await getOrCreateAccount(db, { id: A.userId, email: "a@x.com" })).id).toBe(A.accountId);
    const userId = await db.value<string>("insert into users (email, password_hash) values ('new@example.com', '$2b$04$x') returning id");
    const created = await getOrCreateAccount(db, { id: userId, email: "new@example.com" });
    expect(created.owner_user_id).toBe(userId);
    expect(created.stripe_connection_status).toBe("not_connected");
    expect((await getOrCreateAccount(db, { id: userId, email: "new@example.com" })).id).toBe(created.id);
  });

  it("the admin queue is deliberately cross-account (gated by ADMIN_EMAILS in the page)", async () => {
    const q = await loadAdminQueue(db);
    expect(q.open.map((d) => d.accountName).sort()).toEqual(["A", "B"]);
    expect(q.open.every((d) => d.save !== null)).toBe(true);
  });
});
