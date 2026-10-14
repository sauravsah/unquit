/** 0009_dodo_billing.sql: the database-level guards against double charging. */
import { beforeAll, describe, expect, it } from "vitest";
import { addFounder, createTestDb, type TestDb } from "@/lib/db/testing/pglite";

let db: TestDb;
let acc = "";
let periodId = "";

beforeAll(async () => {
  db = await createTestDb();
  ({ accountId: acc } = await addFounder(db, { stripe: "acct_0009" }));
  periodId = await db.value<string>(
    `insert into billing_periods (account_id, period_month, status, gross_cents, capped_cents, total_cents, amount_due_cents, payment_status)
     values ($1, '2026-09-01', 'closed', 500, 500, 500, 500, 'scheduled') returning id`,
    [acc],
  );
}, 60_000);

describe("dodo billing schema", () => {
  it("keeps amount due = own total + carried in", async () => {
    expect(await db.fails(`update billing_periods set amount_due_cents = 1 where id = '${periodId}'`)).toBe(true);
    expect(await db.fails(`update billing_periods set payment_status = 'bogus' where id = '${periodId}'`)).toBe(true);
  });

  it("allows one charge per statement, positive amounts only, and one attempt in flight", async () => {
    const chargeId = await db.value<string>(
      `insert into billing_charges (account_id, billing_period_id, amount_cents, next_attempt_at) values ($1, $2, 500, now()) returning id`,
      [acc, periodId],
    );
    expect(await db.fails(`insert into billing_charges (account_id, billing_period_id, amount_cents, next_attempt_at) values ('${acc}', '${periodId}', 500, now())`)).toBe(true);
    expect(await db.fails(`update billing_charges set amount_cents = 0 where id = '${chargeId}'`)).toBe(true);
    expect(await db.fails(`update billing_charges set status = 'scheduled', next_attempt_at = null where id = '${chargeId}'`)).toBe(true);
    expect(await db.fails(`update billing_charges set status = 'paid' where id = '${chargeId}'`)).toBe(true);

    await db.exec(`insert into billing_charge_attempts (charge_id, attempt_no, amount_cents) values ('${chargeId}', 1, 500)`);
    expect(await db.fails(`insert into billing_charge_attempts (charge_id, attempt_no, amount_cents) values ('${chargeId}', 2, 500)`)).toBe(true);
    expect(await db.fails(`insert into billing_charge_attempts (charge_id, attempt_no, amount_cents, state) values ('${chargeId}', 1, 500, 'failed')`)).toBe(true);
    await db.exec(`update billing_charge_attempts set state = 'failed' where charge_id = '${chargeId}'`);
    await db.exec(`insert into billing_charge_attempts (charge_id, attempt_no, amount_cents) values ('${chargeId}', 2, 500)`);
    expect(await db.fails(`insert into billing_charge_attempts (charge_id, attempt_no, amount_cents, state) values ('${chargeId}', 9, 500, 'failed')`)).toBe(true);
  });

  it("gives each Dodo subscription to one account only", async () => {
    const other = await addFounder(db, { stripe: "acct_0009b" });
    await db.exec(`update accounts set dodo_subscription_id = 'sub_one' where id = '${acc}'`);
    expect(await db.fails(`update accounts set dodo_subscription_id = 'sub_one' where id = '${other.accountId}'`)).toBe(true);
  });
});
