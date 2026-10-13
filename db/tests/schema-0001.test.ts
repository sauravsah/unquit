/** 0001_init.sql (+ the users table from 0005): accounts, subscription cache and the save ledger. */
import { beforeAll, describe, expect, it } from "vitest";
import { addFounder, createTestDb, type TestDb } from "@/lib/db/testing/pglite";

let db: TestDb;
let accA = "";
let accB = "";
let userA = "";

beforeAll(async () => {
  db = await createTestDb();
  ({ accountId: accA, userId: userA } = await addFounder(db, { name: "A org" }));
  ({ accountId: accB } = await addFounder(db, { name: "B org", stripe: "acct_B" }));
}, 60_000);

describe("accounts", () => {
  it("gives each founder (user) exactly one account", async () => {
    expect(await db.fails(`insert into accounts (owner_user_id, name) values ('${userA}', 'second org')`)).toBe(true);
  });

  it("allows one active connection per Stripe account", async () => {
    expect(await db.fails(`update accounts set stripe_account_id = 'acct_B', stripe_connection_status = 'connected' where id = '${accA}'`)).toBe(true);
    // A disconnected row may keep the old acct_ id for history.
    await db.exec(`update accounts set stripe_account_id = 'acct_B', stripe_connection_status = 'disconnected' where id = '${accA}'`);
    await db.exec(`update accounts set stripe_account_id = null, stripe_connection_status = 'not_connected' where id = '${accA}'`);
  });

  it("checks the connection status", async () => {
    expect(await db.fails(`update accounts set stripe_connection_status = 'maybe' where id = '${accA}'`)).toBe(true);
  });
});

describe("subscriptions_cache", () => {
  it("ignores out-of-order (older) webhook events", async () => {
    await db.exec(`
      select upsert_subscription_cache('${accB}', 'sub_1', 'cus_1', 'past_due', 4900, 'usd', false, null, null, null, '2026-10-02T00:00:00Z');
      select upsert_subscription_cache('${accB}', 'sub_1', 'cus_1', 'active',   4900, 'usd', false, null, null, null, '2026-10-01T00:00:00Z');
    `);
    expect(await db.value(`select status from subscriptions_cache where stripe_subscription_id = 'sub_1'`)).toBe("past_due");
    await db.exec(`select upsert_subscription_cache('${accB}', 'sub_1', 'cus_1', 'active', 4900, 'usd', false, null, null, null, '2026-10-03T00:00:00Z')`);
    expect(await db.value(`select status from subscriptions_cache where stripe_subscription_id = 'sub_1'`)).toBe("active");
  });
});

describe("saves ledger", () => {
  it("issues a receipt number and requires a cancel session for cancel saves", async () => {
    const session = await db.value<string>(
      `insert into cancel_sessions (account_id, stripe_customer_id, stripe_subscription_id, offer_accepted, offer_accepted_at, status)
       values ('${accB}', 'cus_1', 'sub_1', true, now(), 'offer_accepted') returning id`,
    );
    const receipt = await db.value<string>(
      `insert into saves (account_id, type, cancel_session_id, stripe_customer_id, stripe_subscription_id, saved_mrr_cents)
       values ('${accB}', 'cancel', '${session}', 'cus_1', 'sub_1', 4900) returning receipt_number`,
    );
    expect(receipt).toMatch(/^UQ-\d{7}$/);
    expect(await db.fails(`insert into saves (account_id, type, stripe_customer_id) values ('${accB}', 'cancel', 'cus_1')`)).toBe(true);
  });

  it("keeps an accepted offer consistent with its timestamp", async () => {
    expect(
      await db.fails(`insert into cancel_sessions (account_id, stripe_customer_id, stripe_subscription_id, offer_accepted) values ('${accB}', 'c', 's', true)`),
    ).toBe(true);
  });

  it("returns money as numbers and timestamps as ISO strings through the app's Db layer", async () => {
    const row = (await db.query<{ saved_mrr_cents: unknown; created_at: unknown }>("select saved_mrr_cents, created_at from saves limit 1"))[0]!;
    expect(row.saved_mrr_cents).toBe(4900);
    expect(row.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });
});
