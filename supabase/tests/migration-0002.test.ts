/**
 * Runs 0001_init.sql + 0002_cancel_flow.sql against a real (in-memory, WASM)
 * Postgres, the same way week 1's migration.test.ts does, and checks the new
 * security rules: widget keys, flows RLS, saves idempotency and the rate
 * limiter.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it } from "vitest";

const sql = (name: string) => readFileSync(fileURLToPath(new URL(`../migrations/${name}`, import.meta.url)), "utf8");

const A = "11111111-1111-1111-1111-111111111111";
const B = "22222222-2222-2222-2222-222222222222";
const C = "33333333-3333-3333-3333-333333333333";

let db: PGlite;
let accA = "";
let accB = "";

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

const REASONS = `'[{"id":"too_expensive","label":"Too expensive","offer":{"type":"discount","percentOff":30,"months":3}}]'::jsonb`;

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
  await db.exec(`insert into auth.users values ('${A}', 'a@example.com'), ('${B}', 'b@example.com'), ('${C}', 'c@example.com');`);
  // Accounts that exist BEFORE 0002 runs, like a live database being upgraded.
  accA = (await rows<{ id: string }>(`insert into accounts (owner_user_id, name, stripe_account_id, stripe_connection_status)
     values ('${A}', 'A org', 'acct_A', 'connected') returning id`))[0]!.id;
  accB = (await rows<{ id: string }>(`insert into accounts (owner_user_id, name, stripe_account_id, stripe_connection_status)
     values ('${B}', 'B org', 'acct_B', 'connected') returning id`))[0]!.id;
  await db.exec(sql("0002_cancel_flow.sql"));
}, 60_000);

describe("widget keys", () => {
  it("backfills distinct, well-formed keys onto existing accounts", async () => {
    const keys = await rows<{ pk: string; sk: string }>(
      `select widget_publishable_key as pk, widget_signing_secret as sk from accounts order by name`,
    );
    expect(keys).toHaveLength(2);
    for (const k of keys) {
      expect(k.pk).toMatch(/^pk_[0-9a-f]{32}$/);
      expect(k.sk).toMatch(/^uqsk_[0-9a-f]{64}$/);
    }
    expect(keys[0]!.pk).not.toBe(keys[1]!.pk);
    expect(keys[0]!.sk).not.toBe(keys[1]!.sk);
  });

  it("gives a founder who signs up after the migration their own keys", async () => {
    await asUser(C);
    await db.exec(`insert into accounts (owner_user_id, name) values ('${C}', 'C org')`);
    const own = await rows<{ pk: string }>(`select widget_publishable_key as pk from accounts`);
    expect(own).toHaveLength(1);
    expect(own[0]!.pk).toMatch(/^pk_[0-9a-f]{32}$/);
    await asService();
  });

  it("lets a founder read only their own keys", async () => {
    await asUser(A);
    expect(await rows(`select widget_signing_secret from accounts where id = '${accB}'`)).toHaveLength(0);
    expect(await rows(`select widget_signing_secret from accounts where id = '${accA}'`)).toHaveLength(1);
    await asAnon();
    expect(await count("accounts")).toBe(0);
    await asService();
  });

  it("never lets a founder choose or overwrite keys from the browser", async () => {
    await asUser(A);
    expect(await fails(`update accounts set widget_signing_secret = 'uqsk_known' where id = '${accA}'`)).toBe(true);
    expect(await fails(`update accounts set widget_publishable_key = 'pk_0' where id = '${accA}'`)).toBe(true);
    await asUser(C);
    expect(await fails(`insert into accounts (owner_user_id, widget_signing_secret) values ('${C}', 'uqsk_known')`)).toBe(true);
    await asService();
  });

  it("rotates only the caller's own signing secret", async () => {
    const before = await rows<{ id: string; sk: string }>(`select id, widget_signing_secret as sk from accounts`);
    await asUser(A);
    await db.exec(`select rotate_widget_signing_secret()`);
    await asService();
    const after = await rows<{ id: string; sk: string }>(`select id, widget_signing_secret as sk from accounts`);
    for (const row of after) {
      const old = before.find((b) => b.id === row.id)!.sk;
      if (row.id === accA) expect(row.sk).not.toBe(old);
      else expect(row.sk).toBe(old);
    }
    await asAnon();
    expect(await fails(`select rotate_widget_signing_secret()`)).toBe(true);
    await asService();
  });
});

describe("flows (RLS like week 1)", () => {
  it("lets a founder create, read, update and delete their own flow", async () => {
    await asUser(A);
    await db.exec(`insert into flows (account_id, reasons) values ('${accA}', ${REASONS})`);
    await db.exec(`update flows set template = 'pause_first', offer_cooldown_days = 30 where account_id = '${accA}'`);
    const own = await rows<{ template: string; cancel_mode: string; offer_cooldown_days: number }>(
      `select template, cancel_mode, offer_cooldown_days from flows`,
    );
    expect(own).toEqual([{ template: "pause_first", cancel_mode: "period_end", offer_cooldown_days: 30 }]);
    await asService();
  });

  it("blocks reading or writing another founder's flow", async () => {
    await asService();
    await db.exec(`insert into flows (account_id, reasons) values ('${accB}', ${REASONS})`);
    await asUser(A);
    expect(await count("flows")).toBe(1); // only their own
    expect(await fails(`insert into flows (account_id, reasons) values ('${accB}', ${REASONS})`)).toBe(true);
    await db.exec(`update flows set template = 'custom' where account_id = '${accB}'`); // silently matches 0 rows
    await db.exec(`delete from flows where account_id = '${accB}'`);
    expect(await fails(`update flows set account_id = '${accB}' where account_id = '${accA}'`)).toBe(true);
    await asService();
    expect((await rows<{ template: string }>(`select template from flows where account_id = '${accB}'`))[0]!.template).toBe(
      "balanced",
    );
  });

  it("allows one flow per account and checks the stored shape", async () => {
    expect(await fails(`insert into flows (account_id, reasons) values ('${accB}', ${REASONS})`)).toBe(true);
    await asUser(A);
    expect(await fails(`update flows set reasons = '{"not":"an array"}'::jsonb`)).toBe(true);
    expect(await fails(`update flows set reasons = '[]'::jsonb`)).toBe(true);
    expect(await fails(`update flows set cancel_mode = 'never'`)).toBe(true);
    expect(await fails(`update flows set offer_cooldown_days = -1`)).toBe(true);
    await asService();
  });
});

describe("cancel sessions and the save ledger", () => {
  it("keeps cancel sessions read-only for founders, scoped to their account", async () => {
    await db.exec(`insert into cancel_sessions (account_id, stripe_customer_id, stripe_subscription_id, reason, reason_label, offers_enabled, cancel_mode, status)
      values ('${accB}', 'cus_1', 'sub_1', 'too_expensive', 'Too expensive', false, 'period_end', 'canceled')`);
    await asUser(A);
    expect(await count("cancel_sessions")).toBe(0);
    expect(
      await fails(`insert into cancel_sessions (account_id, stripe_customer_id, stripe_subscription_id) values ('${accA}', 'cus_x', 'sub_x')`),
    ).toBe(true);
    await asUser(B);
    expect(await rows(`select reason_label, offers_enabled, cancel_mode from cancel_sessions`)).toEqual([
      { reason_label: "Too expensive", offers_enabled: false, cancel_mode: "period_end" },
    ]);
    await asService();
    expect(
      await fails(`update cancel_sessions set cancel_mode = 'sometime' where account_id = '${accB}'`),
    ).toBe(true);
  });

  it("records at most one save per cancel session, so a retried accept is a no-op", async () => {
    const session = (
      await rows<{ id: string }>(`insert into cancel_sessions (account_id, stripe_customer_id, stripe_subscription_id, offer_accepted, offer_accepted_at, status)
        values ('${accB}', 'cus_2', 'sub_2', true, now(), 'offer_accepted') returning id`)
    )[0]!.id;
    const insert = `insert into saves (account_id, type, cancel_session_id, stripe_customer_id, stripe_subscription_id, saved_mrr_cents)
      values ('${accB}', 'cancel', '${session}', 'cus_2', 'sub_2', 3430)
      on conflict (cancel_session_id) do nothing`;
    await db.exec(insert);
    await db.exec(insert); // what PostgREST's upsert(ignoreDuplicates) sends on a retry
    expect((await rows<{ c: number }>(`select count(*)::int as c from saves where cancel_session_id = '${session}'`))[0]!.c).toBe(1);
    // Dunning saves (no cancel session) still don't clash with each other on NULL.
    expect(await count("saves")).toBe(1);
  });
});

describe("widget rate limiter", () => {
  it("allows up to the limit in a window, then refuses", async () => {
    const hit = async () =>
      (await rows<{ ok: boolean }>(`select widget_rate_limit_hit('ip:203.0.113.9', 60, 3) as ok`))[0]!.ok;
    expect([await hit(), await hit(), await hit(), await hit(), await hit()]).toEqual([true, true, true, false, false]);
    // Buckets are independent.
    expect((await rows<{ ok: boolean }>(`select widget_rate_limit_hit('ip:198.51.100.1', 60, 3) as ok`))[0]!.ok).toBe(true);
  });

  it("is service-role only", async () => {
    await asUser(A);
    expect(await fails(`select widget_rate_limit_hit('ip:x', 60, 1000)`)).toBe(true);
    expect(await count("widget_rate_limits")).toBe(0);
    await asAnon();
    expect(await fails(`select widget_rate_limit_hit('ip:x', 60, 1000)`)).toBe(true);
    await asService();
  });
});
