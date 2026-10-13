/** 0002_cancel_flow.sql: widget keys, flows, cancel-session columns, one save per session, the rate limiter. */
import { beforeAll, describe, expect, it } from "vitest";
import { addFounder, createTestDb, migrateTo, type TestDb } from "@/lib/db/testing/pglite";

let db: TestDb;
let accA = "";
let accB = "";

const REASONS = `'[{"id":"too_expensive","label":"Too expensive","offer":{"type":"discount","percentOff":30,"months":3}}]'::jsonb`;

beforeAll(async () => {
  // Upgrade path: accounts exist BEFORE 0002 runs, like a live database.
  db = await createTestDb({ upTo: "0001" });
  accA = await db.value<string>(
    `insert into accounts (owner_user_id, name, stripe_account_id, stripe_connection_status) values (gen_random_uuid(), 'A org', 'acct_A', 'connected') returning id`,
  );
  accB = await db.value<string>(
    `insert into accounts (owner_user_id, name, stripe_account_id, stripe_connection_status) values (gen_random_uuid(), 'B org', 'acct_B', 'connected') returning id`,
  );
  await migrateTo(db, "0004");
}, 60_000);

describe("widget keys", () => {
  it("backfills distinct, well-formed keys onto existing accounts", async () => {
    const keys = await db.query<{ pk: string; sk: string }>(`select widget_publishable_key as pk, widget_signing_secret as sk from accounts order by name`);
    expect(keys).toHaveLength(2);
    for (const k of keys) {
      expect(k.pk).toMatch(/^pk_[0-9a-f]{32}$/);
      expect(k.sk).toMatch(/^uqsk_[0-9a-f]{64}$/);
    }
    expect(keys[0]!.pk).not.toBe(keys[1]!.pk);
    expect(keys[0]!.sk).not.toBe(keys[1]!.sk);
  });

  it("gives a founder who signs up after the migration their own keys, unique across accounts", async () => {
    const pk = await db.value<string>(`insert into accounts (owner_user_id, name) values (gen_random_uuid(), 'C org') returning widget_publishable_key`);
    expect(pk).toMatch(/^pk_[0-9a-f]{32}$/);
    expect(await db.fails(`update accounts set widget_publishable_key = '${pk}' where id = '${accA}'`)).toBe(true);
  });

  it("generates a fresh signing secret on each call (used by rotation)", async () => {
    const [a, b] = [await db.value<string>("select new_widget_signing_secret()"), await db.value<string>("select new_widget_signing_secret()")];
    expect(a).toMatch(/^uqsk_[0-9a-f]{64}$/);
    expect(a).not.toBe(b);
  });
});

describe("flows", () => {
  it("stores a flow with defaults and allows one per account", async () => {
    await db.exec(`insert into flows (account_id, reasons) values ('${accA}', ${REASONS})`);
    expect(await db.query(`select template, cancel_mode, offer_cooldown_days from flows where account_id = '${accA}'`)).toEqual([
      { template: "balanced", cancel_mode: "period_end", offer_cooldown_days: 90 },
    ]);
    expect(await db.fails(`insert into flows (account_id, reasons) values ('${accA}', ${REASONS})`)).toBe(true);
  });

  it("checks the stored shape", async () => {
    expect(await db.fails(`update flows set reasons = '{"not":"an array"}'::jsonb where account_id = '${accA}'`)).toBe(true);
    expect(await db.fails(`update flows set reasons = '[]'::jsonb where account_id = '${accA}'`)).toBe(true);
    expect(await db.fails(`update flows set cancel_mode = 'never' where account_id = '${accA}'`)).toBe(true);
    expect(await db.fails(`update flows set offer_cooldown_days = -1 where account_id = '${accA}'`)).toBe(true);
    expect(await db.fails(`update flows set template = 'mystery' where account_id = '${accA}'`)).toBe(true);
  });
});

describe("cancel sessions and the save ledger", () => {
  it("records what the widget showed and checks the cancel mode", async () => {
    await db.exec(`insert into cancel_sessions (account_id, stripe_customer_id, stripe_subscription_id, reason, reason_label, offers_enabled, cancel_mode, status)
      values ('${accB}', 'cus_1', 'sub_1', 'too_expensive', 'Too expensive', false, 'period_end', 'canceled')`);
    expect(await db.query(`select reason_label, offers_enabled, cancel_mode from cancel_sessions where account_id = '${accB}'`)).toEqual([
      { reason_label: "Too expensive", offers_enabled: false, cancel_mode: "period_end" },
    ]);
    expect(await db.fails(`update cancel_sessions set cancel_mode = 'sometime' where account_id = '${accB}'`)).toBe(true);
  });

  it("records at most one save per cancel session, so a retried accept is a no-op", async () => {
    const session = await db.value<string>(`insert into cancel_sessions (account_id, stripe_customer_id, stripe_subscription_id, offer_accepted, offer_accepted_at, status)
        values ('${accB}', 'cus_2', 'sub_2', true, now(), 'offer_accepted') returning id`);
    const insert = `insert into saves (account_id, type, cancel_session_id, stripe_customer_id, stripe_subscription_id, saved_mrr_cents)
      values ('${accB}', 'cancel', '${session}', 'cus_2', 'sub_2', 3430)
      on conflict (cancel_session_id) do nothing`;
    await db.exec(insert);
    await db.exec(insert); // what the widget repo sends on a retry
    expect(await db.count("saves", `cancel_session_id = '${session}'`)).toBe(1);
  });
});

describe("widget rate limiter", () => {
  it("allows up to the limit in a window, then refuses; buckets are independent", async () => {
    const hit = (bucket: string) => db.value<boolean>(`select widget_rate_limit_hit('${bucket}', 60, 3) as ok`);
    expect([await hit("ip:203.0.113.9"), await hit("ip:203.0.113.9"), await hit("ip:203.0.113.9"), await hit("ip:203.0.113.9")]).toEqual([
      true,
      true,
      true,
      false,
    ]);
    expect(await hit("ip:198.51.100.1")).toBe(true);
  });
});
