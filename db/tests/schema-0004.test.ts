/** 0004_ledger_billing.sql: lost/ended saves, clawbacks, holds, billing periods, timeline, disputes, platform billing. */
import { beforeAll, describe, expect, it } from "vitest";
import { createTestDb, migrateTo, type TestDb } from "@/lib/db/testing/pglite";

let db: TestDb;
let accA = "";
let accB = "";
let saveB = "";
let lineB = "";
let legacyLine = "";

beforeAll(async () => {
  db = await createTestDb({ upTo: "0003" });
  const acct = (name: string, stripe: string) =>
    db.value<string>(
      `insert into accounts (owner_user_id, name, stripe_account_id, stripe_connection_status) values (gen_random_uuid(), '${name}', '${stripe}', 'connected') returning id`,
    );
  accA = await acct("A org", "acct_A");
  accB = await acct("B org", "acct_B");
  // A week-3 dunning save with its fee line, created BEFORE 0004 runs.
  const caseB = await db.value<string>(
    `insert into dunning_cases (account_id, stripe_invoice_id, stripe_customer_id, amount_due_cents) values ('${accB}', 'in_d', 'cus_d', 4900) returning id`,
  );
  const legacySave = await db.value<string>(`insert into saves (account_id, type, dunning_case_id, stripe_customer_id, stripe_invoice_id, recovered_amount_cents, fee_cents, status, verified_at, attributed_via)
     values ('${accB}', 'dunning', '${caseB}', 'cus_d', 'in_d', 4900, 490, 'verified', now(), 'update_link') returning id`);
  legacyLine = await db.value<string>(`insert into save_fee_lines (save_id, account_id, month_index, billing_month, stripe_invoice_id, amount_cents)
     values ('${legacySave}', '${accB}', 1, '2026-09-01', 'in_d', 490) returning id`);

  await migrateTo(db, "0004");

  const session = await db.value<string>(
    `insert into cancel_sessions (account_id, stripe_customer_id, stripe_subscription_id) values ('${accB}', 'cus_1', 'sub_1') returning id`,
  );
  saveB = await db.value<string>(`insert into saves (account_id, type, cancel_session_id, stripe_customer_id, stripe_subscription_id, saved_mrr_cents, status, verified_at, stripe_invoice_id)
     values ('${accB}', 'cancel', '${session}', 'cus_1', 'sub_1', 10000, 'verified', now(), 'in_1') returning id`);
  lineB = await db.value<string>(`insert into save_fee_lines (save_id, account_id, month_index, billing_month, stripe_invoice_id, amount_cents, invoice_amount_paid_cents)
     values ('${saveB}', '${accB}', 1, '2026-09-01', 'in_1', 2000, 10000) returning id`);
  await db.exec(`
    insert into billing_periods (account_id, period_month, status, gross_cents, capped_cents, total_cents, stripe_invoice_id)
      values ('${accB}', '2026-09-01', 'invoiced', 2000, 2000, 2000, 'in_platform_1');
    insert into save_events (account_id, save_id, kind, dedupe_key) values ('${accB}', '${saveB}', 'verified', 'verified:${saveB}');
  `);
}, 60_000);

describe("0004 keeps existing data", () => {
  it("teaches week-3 dunning fee lines the invoice amount they came from", async () => {
    expect(await db.query(`select invoice_amount_paid_cents, clawed_back_cents, status from save_fee_lines where id = '${legacyLine}'`)).toEqual([
      { invoice_amount_paid_cents: 4900, clawed_back_cents: 0, status: "earned" },
    ]);
  });
});

describe("constraints", () => {
  it("adds 'lost' with a reason, and keeps lost/ended consistent", async () => {
    const session = await db.value<string>(
      `insert into cancel_sessions (account_id, stripe_customer_id, stripe_subscription_id) values ('${accB}', 'cus_2', 'sub_2') returning id`,
    );
    const s = await db.value<string>(
      `insert into saves (account_id, type, cancel_session_id, stripe_customer_id, stripe_subscription_id) values ('${accB}', 'cancel', '${session}', 'cus_2', 'sub_2') returning id`,
    );
    expect(await db.fails(`update saves set status = 'lost' where id = '${s}'`)).toBe(true);
    expect(await db.fails(`update saves set status = 'lost', lost_at = now(), lost_reason = 'bored' where id = '${s}'`)).toBe(true);
    await db.exec(`update saves set status = 'lost', lost_at = now(), lost_reason = 'expired' where id = '${s}'`);
    expect(await db.fails(`update saves set ended_at = now() where id = '${saveB}'`)).toBe(true);
    await db.exec(`update saves set ended_at = now(), end_reason = 'customer_canceled' where id = '${saveB}'`);
    await db.exec(`update saves set ended_at = null, end_reason = null where id = '${saveB}'`);
  });

  it("keeps clawbacks within the fee and one fee line per invoice per save", async () => {
    expect(await db.fails(`update save_fee_lines set clawed_back_cents = 2001 where id = '${lineB}'`)).toBe(true);
    expect(await db.fails(`update save_fee_lines set clawed_back_cents = -1 where id = '${lineB}'`)).toBe(true);
    expect(
      await db.fails(
        `insert into save_fee_lines (save_id, account_id, month_index, billing_month, stripe_invoice_id, amount_cents) values ('${saveB}', '${accB}', 2, '2026-10-01', 'in_1', 2000)`,
      ),
    ).toBe(true);
    expect(
      await db.fails(`insert into fee_clawbacks (account_id, save_id, fee_line_id, kind, amount_cents) values ('${accB}', '${saveB}', '${lineB}', 'refund', 0)`),
    ).toBe(true);
  });

  it("makes billing periods unique per account and month, with consistent maths", async () => {
    expect(await db.fails(`insert into billing_periods (account_id, period_month) values ('${accB}', '2026-09-01')`)).toBe(true);
    expect(await db.fails(`insert into billing_periods (account_id, period_month) values ('${accB}', '2026-09-15')`)).toBe(true);
    expect(
      await db.fails(`insert into billing_periods (account_id, period_month, gross_cents, capped_cents, total_cents) values ('${accB}', '2026-07-01', 40000, 40000, 40000)`),
    ).toBe(true); // over the $299 cap
    expect(await db.fails(`insert into billing_periods (account_id, period_month, status) values ('${accB}', '2026-06-01', 'invoiced')`)).toBe(true);
    await db.exec(`insert into billing_periods (account_id, period_month, gross_cents, cap_discount_cents, capped_cents, credit_applied_cents, total_cents)
      values ('${accB}', '2026-08-01', 40000, 10100, 29900, 900, 29000)`);
    expect(await db.value(`select cap_cents from billing_periods where account_id = '${accB}' and period_month = '2026-08-01'`)).toBe(29900);
  });

  it("dedupes timeline events and allows one open dispute per save", async () => {
    expect(
      await db.fails(`insert into save_events (account_id, save_id, kind, dedupe_key) values ('${accB}', '${saveB}', 'verified', 'verified:${saveB}')`),
    ).toBe(true);
    await db.exec(`insert into disputes (save_id, account_id, reason, category) values ('${saveB}', '${accB}', 'x', 'would_have_stayed')`);
    expect(await db.fails(`insert into disputes (save_id, account_id, reason, category) values ('${saveB}', '${accB}', 'y', 'other')`)).toBe(true);
    expect(
      await db.fails(`insert into disputes (save_id, account_id, reason, category, status) values ('${saveB}', '${accB}', 'y', 'nonsense', 'accepted')`),
    ).toBe(true);
    expect(await db.fails(`update disputes set status = 'accepted' where save_id = '${saveB}'`)).toBe(true); // resolved_at goes with it
    await db.exec(`update disputes set status = 'rejected', resolved_at = now(), resolution = 'admin' where save_id = '${saveB}'`);
  });

  it("checks the saved card's last 4 and keeps platform customers unique", async () => {
    await db.exec(`update accounts set platform_customer_id = 'cus_platform_B', billing_pm_status = 'active', billing_pm_last4 = '4242' where id = '${accB}'`);
    expect(await db.fails(`update accounts set billing_pm_last4 = '42x2' where id = '${accB}'`)).toBe(true);
    expect(await db.fails(`update accounts set billing_pm_status = 'maybe' where id = '${accB}'`)).toBe(true);
    expect(await db.fails(`update accounts set platform_customer_id = 'cus_platform_B' where id = '${accA}'`)).toBe(true);
  });
});
