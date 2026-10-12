/**
 * Runs 0001 → 0004 against a real (in-memory, WASM) Postgres and checks
 * week 4's rules: founders can read their own ledger, receipts, disputes and
 * statements, but can't write a single fee line, status or billing row from
 * the browser. Only the service role (server code) can.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it } from "vitest";

const sql = (name: string) => readFileSync(fileURLToPath(new URL(`../migrations/${name}`, import.meta.url)), "utf8");

const A = "11111111-1111-1111-1111-111111111111";
const B = "22222222-2222-2222-2222-222222222222";

let db: PGlite;
let accA = "";
let accB = "";
let saveB = "";
let lineB = "";
let periodB = "";
let legacyLine = "";

const asUser = async (userId: string) => {
  await db.exec("reset role");
  await db.exec(`set role authenticated; select set_config('request.jwt.claim.sub', '${userId}', false);`);
};
const asAnon = async () => {
  await db.exec("reset role");
  await db.exec(`set role anon; select set_config('request.jwt.claim.sub', '', false);`);
};
const asService = () => db.exec("reset role");
const fails = async (statement: string) => {
  try {
    await db.exec(statement);
    return false;
  } catch {
    return true;
  }
};
const rows = async <T>(q: string) => (await db.query<T>(q)).rows;
const count = async (table: string) => (await rows<{ c: number }>(`select count(*)::int as c from ${table}`))[0]!.c;
const id = async (q: string) => (await rows<{ id: string }>(q))[0]!.id;

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    create role anon; create role authenticated;
    create schema auth;
    create table auth.users (id uuid primary key, email text);
    create function auth.uid() returns uuid language sql stable
      as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    grant usage on schema public to anon, authenticated;
    alter default privileges in schema public grant all on tables to anon, authenticated;
    alter default privileges in schema public grant all on sequences to anon, authenticated;
    alter default privileges in schema public grant all on functions to anon, authenticated;
  `);
  await db.exec(sql("0001_init.sql"));
  await db.exec(sql("0002_cancel_flow.sql"));
  await db.exec(sql("0003_dunning.sql"));
  await db.exec(`insert into auth.users values ('${A}', 'a@example.com'), ('${B}', 'b@example.com');`);
  accA = await id(`insert into accounts (owner_user_id, name, stripe_account_id, stripe_connection_status) values ('${A}', 'A org', 'acct_A', 'connected') returning id`);
  accB = await id(`insert into accounts (owner_user_id, name, stripe_account_id, stripe_connection_status) values ('${B}', 'B org', 'acct_B', 'connected') returning id`);

  // A week-3 dunning save with its fee line, created BEFORE 0004 runs.
  const caseB = await id(`insert into dunning_cases (account_id, stripe_invoice_id, stripe_customer_id, amount_due_cents) values ('${accB}', 'in_d', 'cus_d', 4900) returning id`);
  const legacySave = await id(`insert into saves (account_id, type, dunning_case_id, stripe_customer_id, stripe_invoice_id, recovered_amount_cents, fee_cents, status, verified_at, attributed_via)
     values ('${accB}', 'dunning', '${caseB}', 'cus_d', 'in_d', 4900, 490, 'verified', now(), 'update_link') returning id`);
  legacyLine = await id(`insert into save_fee_lines (save_id, account_id, month_index, billing_month, stripe_invoice_id, amount_cents)
     values ('${legacySave}', '${accB}', 1, '2026-09-01', 'in_d', 490) returning id`);

  await db.exec(sql("0004_ledger_billing.sql"));

  const session = await id(`insert into cancel_sessions (account_id, stripe_customer_id, stripe_subscription_id) values ('${accB}', 'cus_1', 'sub_1') returning id`);
  saveB = await id(`insert into saves (account_id, type, cancel_session_id, stripe_customer_id, stripe_subscription_id, saved_mrr_cents, status, verified_at, stripe_invoice_id)
     values ('${accB}', 'cancel', '${session}', 'cus_1', 'sub_1', 10000, 'verified', now(), 'in_1') returning id`);
  lineB = await id(`insert into save_fee_lines (save_id, account_id, month_index, billing_month, stripe_invoice_id, amount_cents, invoice_amount_paid_cents)
     values ('${saveB}', '${accB}', 1, '2026-09-01', 'in_1', 2000, 10000) returning id`);
  periodB = await id(`insert into billing_periods (account_id, period_month, status, gross_cents, capped_cents, total_cents, stripe_invoice_id)
     values ('${accB}', '2026-09-01', 'invoiced', 2000, 2000, 2000, 'in_platform_1') returning id`);
  await db.exec(`
    insert into invoice_reversals (account_id, stripe_invoice_id, source_key, kind, amount_cents) values ('${accB}', 'in_1', 'charge:ch_1', 'refund', 2500);
    insert into fee_clawbacks (account_id, save_id, fee_line_id, kind, source, amount_cents) values ('${accB}', '${saveB}', '${lineB}', 'refund', 'charge:ch_1', 500);
    insert into save_events (account_id, save_id, kind, dedupe_key) values ('${accB}', '${saveB}', 'verified', 'verified:${saveB}');
  `);
}, 60_000);

describe("0004 keeps existing data", () => {
  it("teaches week-3 dunning fee lines the invoice amount they came from", async () => {
    expect(await rows(`select invoice_amount_paid_cents, clawed_back_cents, status from save_fee_lines where id = '${legacyLine}'`)).toEqual([
      { invoice_amount_paid_cents: 4900, clawed_back_cents: 0, status: "earned" },
    ]);
  });
});

describe("constraints", () => {
  it("adds 'lost' with a reason, and keeps lost/ended consistent", async () => {
    const session = await id(`insert into cancel_sessions (account_id, stripe_customer_id, stripe_subscription_id) values ('${accB}', 'cus_2', 'sub_2') returning id`);
    const s = await id(`insert into saves (account_id, type, cancel_session_id, stripe_customer_id, stripe_subscription_id) values ('${accB}', 'cancel', '${session}', 'cus_2', 'sub_2') returning id`);
    expect(await fails(`update saves set status = 'lost' where id = '${s}'`)).toBe(true); // needs lost_at + reason
    expect(await fails(`update saves set status = 'lost', lost_at = now(), lost_reason = 'bored' where id = '${s}'`)).toBe(true);
    await db.exec(`update saves set status = 'lost', lost_at = now(), lost_reason = 'expired' where id = '${s}'`);
    expect(await fails(`update saves set ended_at = now() where id = '${saveB}'`)).toBe(true); // needs end_reason
    await db.exec(`update saves set ended_at = now(), end_reason = 'customer_canceled' where id = '${saveB}'`);
    await db.exec(`update saves set ended_at = null, end_reason = null where id = '${saveB}'`);
  });

  it("keeps clawbacks within the fee and one fee line per invoice per save", async () => {
    expect(await fails(`update save_fee_lines set clawed_back_cents = 2001 where id = '${lineB}'`)).toBe(true);
    expect(await fails(`update save_fee_lines set clawed_back_cents = -1 where id = '${lineB}'`)).toBe(true);
    expect(
      await fails(`insert into save_fee_lines (save_id, account_id, month_index, billing_month, stripe_invoice_id, amount_cents) values ('${saveB}', '${accB}', 2, '2026-10-01', 'in_1', 2000)`),
    ).toBe(true);
    expect(await fails(`insert into fee_clawbacks (account_id, save_id, fee_line_id, kind, amount_cents) values ('${accB}', '${saveB}', '${lineB}', 'refund', 0)`)).toBe(true);
  });

  it("makes billing periods unique per account and month, with consistent maths", async () => {
    expect(await fails(`insert into billing_periods (account_id, period_month) values ('${accB}', '2026-09-01')`)).toBe(true);
    expect(await fails(`insert into billing_periods (account_id, period_month) values ('${accB}', '2026-09-15')`)).toBe(true);
    expect(await fails(`insert into billing_periods (account_id, period_month, gross_cents, capped_cents, total_cents) values ('${accB}', '2026-07-01', 40000, 40000, 40000)`)).toBe(true); // over the cap
    expect(await fails(`insert into billing_periods (account_id, period_month, status) values ('${accB}', '2026-06-01', 'invoiced')`)).toBe(true); // invoiced needs an invoice
    await db.exec(`insert into billing_periods (account_id, period_month, gross_cents, cap_discount_cents, capped_cents, credit_applied_cents, total_cents)
      values ('${accB}', '2026-08-01', 40000, 10100, 29900, 900, 29000)`);
  });

  it("dedupes timeline events and allows one open dispute per save", async () => {
    expect(await fails(`insert into save_events (account_id, save_id, kind, dedupe_key) values ('${accB}', '${saveB}', 'verified', 'verified:${saveB}')`)).toBe(true);
    await db.exec(`insert into disputes (save_id, account_id, reason, category) values ('${saveB}', '${accB}', 'x', 'would_have_stayed')`);
    expect(await fails(`insert into disputes (save_id, account_id, reason, category) values ('${saveB}', '${accB}', 'y', 'other')`)).toBe(true);
    expect(await fails(`insert into disputes (save_id, account_id, reason, category, status) values ('${saveB}', '${accB}', 'y', 'nonsense', 'accepted')`)).toBe(true);
    // resolved_at goes with a resolved status
    expect(await fails(`update disputes set status = 'accepted' where save_id = '${saveB}'`)).toBe(true);
    await db.exec(`update disputes set status = 'rejected', resolved_at = now(), resolution = 'admin' where save_id = '${saveB}'`);
  });
});

describe("RLS: founders read their own rows only", () => {
  it("shows founder B their ledger, receipts, disputes and statements, and founder A nothing", async () => {
    await asUser(B);
    for (const t of ["billing_periods", "invoice_reversals", "fee_clawbacks", "save_events", "save_fee_lines", "disputes"]) {
      expect(await count(t)).toBeGreaterThan(0);
    }
    await asUser(A);
    for (const t of ["billing_periods", "invoice_reversals", "fee_clawbacks", "save_events", "save_fee_lines", "disputes", "saves"]) {
      expect(await count(t)).toBe(0);
    }
    await asAnon();
    for (const t of ["billing_periods", "fee_clawbacks", "save_events", "saves"]) expect(await count(t)).toBe(0);
    await asService();
  });
});

describe("RLS: nothing in the ledger or billing can be written from the browser", () => {
  it("blocks founders from editing their own fee lines, save statuses, clawbacks and statements", async () => {
    await asUser(B);
    expect(await fails(`update save_fee_lines set amount_cents = 0 where id = '${lineB}'`)).toBe(true);
    expect(await fails(`update save_fee_lines set held_founder_dispute_id = null`)).toBe(true);
    expect(await fails(`delete from save_fee_lines where id = '${lineB}'`)).toBe(true);
    expect(await fails(`update saves set status = 'clawed_back' where id = '${saveB}'`)).toBe(true);
    expect(await fails(`update saves set fee_cents = 0 where id = '${saveB}'`)).toBe(true);
    expect(await fails(`update billing_periods set total_cents = 0, capped_cents = 0, gross_cents = 0 where id = '${periodB}'`)).toBe(true);
    expect(await fails(`insert into billing_periods (account_id, period_month) values ('${accB}', '2025-01-01')`)).toBe(true);
    expect(await fails(`delete from billing_periods where id = '${periodB}'`)).toBe(true);
    expect(await fails(`insert into fee_clawbacks (account_id, save_id, fee_line_id, kind, amount_cents) values ('${accB}', '${saveB}', '${lineB}', 'refund', 2000)`)).toBe(true);
    expect(await fails(`insert into invoice_reversals (account_id, stripe_invoice_id, source_key, kind, amount_cents) values ('${accB}', 'in_1', 'charge:forged', 'refund', 10000)`)).toBe(true);
    expect(await fails(`insert into save_events (account_id, save_id, kind) values ('${accB}', '${saveB}', 'dispute_accepted')`)).toBe(true);
    expect(await fails(`truncate save_events`)).toBe(true);
    await asService();
    expect(await rows(`select amount_cents, status from save_fee_lines where id = '${lineB}'`)).toEqual([{ amount_cents: 2000, status: "earned" }]);
    expect((await rows<{ status: string }>(`select status from saves where id = '${saveB}'`))[0]!.status).toBe("verified");
    expect((await rows<{ total_cents: number }>(`select total_cents from billing_periods where id = '${periodB}'`))[0]!.total_cents).toBe(2000);
  });

  it("blocks founders from opening or resolving disputes directly (the server does it, with holds and checks)", async () => {
    await asUser(B);
    expect(await fails(`insert into disputes (save_id, account_id, opened_by, reason) values ('${saveB}', '${accB}', '${B}', 'refunded')`)).toBe(true);
    expect(await fails(`update disputes set status = 'accepted', resolved_at = now() where save_id = '${saveB}'`)).toBe(true);
    await asService();
  });

  it("blocks founders from setting their own billing customer or payment-method status", async () => {
    await asUser(B);
    expect(await fails(`update accounts set platform_customer_id = 'cus_someone_else' where id = '${accB}'`)).toBe(true);
    expect(await fails(`update accounts set billing_pm_status = 'active' where id = '${accB}'`)).toBe(true);
    await db.exec(`update accounts set name = 'Renamed' where id = '${accB}'`); // still allowed
    await asService();
    expect(await rows(`select name, platform_customer_id, billing_pm_status from accounts where id = '${accB}'`)).toEqual([
      { name: "Renamed", platform_customer_id: null, billing_pm_status: "none" },
    ]);
  });

  it("lets the service role write everything", async () => {
    await asService();
    await db.exec(`update save_fee_lines set clawed_back_cents = 500 where id = '${lineB}'`);
    await db.exec(`update accounts set platform_customer_id = 'cus_platform_B', billing_pm_status = 'active', billing_pm_last4 = '4242' where id = '${accB}'`);
    expect(await fails(`update accounts set billing_pm_last4 = '42x2' where id = '${accB}'`)).toBe(true);
    expect(await fails(`update accounts set platform_customer_id = 'cus_platform_B' where id = '${accA}'`)).toBe(true); // unique
  });
});
