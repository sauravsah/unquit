/**
 * Runs supabase/migrations/0001_init.sql against a real (in-memory, WASM)
 * Postgres and checks the security rules. Supabase's `auth` schema and roles
 * are stubbed with the minimum needed.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it } from "vitest";

const MIGRATION = readFileSync(fileURLToPath(new URL("../migrations/0001_init.sql", import.meta.url)), "utf8");
const A = "11111111-1111-1111-1111-111111111111";
const B = "22222222-2222-2222-2222-222222222222";

let db: PGlite;
let accB = "";

const asUser = async (userId: string) => {
  await db.exec("reset role");
  await db.exec(`set role authenticated; select set_config('request.jwt.claim.sub', '${userId}', false);`);
};
const asService = () => db.exec("reset role");
const fails = async (sql: string) => {
  try {
    await db.exec(sql);
    return false;
  } catch {
    return true;
  }
};
const count = async (table: string) => (await db.query<{ c: number }>(`select count(*)::int as c from ${table}`)).rows[0]!.c;

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
  await db.exec(MIGRATION);
  await db.exec(`insert into auth.users values ('${A}', 'a@example.com'), ('${B}', 'b@example.com');`);
  const res = await db.query<{ id: string }>(
    `insert into accounts (owner_user_id, name, stripe_account_id, stripe_connection_status)
     values ('${B}', 'B org', 'acct_B', 'connected') returning id`,
  );
  accB = res.rows[0]!.id;
}, 60_000);

describe("accounts", () => {
  it("lets a founder create their own account", async () => {
    await asUser(A);
    await db.exec(`insert into accounts (owner_user_id, name) values ('${A}', 'A org')`);
    expect(await count("accounts")).toBe(1); // sees only their own row
    await asService();
  });

  it("blocks creating an account for someone else", async () => {
    await asUser(A);
    expect(await fails(`insert into accounts (owner_user_id) values ('${B}')`)).toBe(true);
    await asService();
  });

  it("blocks a founder from forging Stripe fields", async () => {
    await asUser(A);
    expect(await fails(`update accounts set stripe_account_id = 'acct_victim'`)).toBe(true);
    expect(
      await fails(
        `insert into accounts (owner_user_id, stripe_account_id, stripe_connection_status) values ('${A}', 'acct_victim', 'connected')`,
      ),
    ).toBe(true);
    await asService();
  });

  it("allows one active connection per Stripe account", async () => {
    expect(
      await fails(
        `update accounts set stripe_account_id = 'acct_B', stripe_connection_status = 'connected' where owner_user_id = '${A}'`,
      ),
    ).toBe(true);
  });
});

describe("subscriptions_cache", () => {
  it("ignores out-of-order (older) webhook events", async () => {
    await db.exec(`
      select upsert_subscription_cache('${accB}', 'sub_1', 'cus_1', 'past_due', 4900, 'usd', false, null, null, null, '2026-10-02T00:00:00Z');
      select upsert_subscription_cache('${accB}', 'sub_1', 'cus_1', 'active',   4900, 'usd', false, null, null, null, '2026-10-01T00:00:00Z');
    `);
    const row = await db.query<{ status: string }>(`select status from subscriptions_cache where stripe_subscription_id = 'sub_1'`);
    expect(row.rows[0]!.status).toBe("past_due");
  });

  it("cannot be written by a signed-in founder", async () => {
    await asUser(B);
    expect(
      await fails(`select upsert_subscription_cache('${accB}', 'sub_x', 'cus_x', 'active', 1, 'usd', false, null, null, null, now())`),
    ).toBe(true);
    await asService();
  });
});

describe("saves ledger", () => {
  it("issues a receipt number and requires a cancel session for cancel saves", async () => {
    const session = await db.query<{ id: string }>(
      `insert into cancel_sessions (account_id, stripe_customer_id, stripe_subscription_id, offer_accepted, offer_accepted_at, status)
       values ('${accB}', 'cus_1', 'sub_1', true, now(), 'offer_accepted') returning id`,
    );
    const save = await db.query<{ receipt_number: string }>(
      `insert into saves (account_id, type, cancel_session_id, stripe_customer_id, stripe_subscription_id, saved_mrr_cents)
       values ('${accB}', 'cancel', '${session.rows[0]!.id}', 'cus_1', 'sub_1', 4900) returning receipt_number`,
    );
    expect(save.rows[0]!.receipt_number).toMatch(/^UQ-\d{7}$/);
    expect(await fails(`insert into saves (account_id, type, stripe_customer_id) values ('${accB}', 'cancel', 'cus_1')`)).toBe(true);
  });

  it("is only visible to the owning founder", async () => {
    await asUser(A);
    expect(await count("saves")).toBe(0);
    expect(await count("subscriptions_cache")).toBe(0);
    await asUser(B);
    expect(await count("saves")).toBe(1);
    expect(await count("webhook_events")).toBe(0); // service role only
    await asService();
  });

  it("lets a founder dispute only their own saves", async () => {
    await asUser(A);
    await db
      .exec(`insert into disputes (save_id, account_id, opened_by, reason) select id, account_id, '${A}', 'x' from saves`)
      .catch(() => undefined);
    await asUser(B);
    await db.exec(
      `insert into disputes (save_id, account_id, opened_by, reason) select id, account_id, '${B}', 'customer was refunded' from saves`,
    );
    await asService();
    expect(await count("disputes")).toBe(1);
  });
});
