/** 0005_auth.sql: the users table that replaced Supabase Auth, and the foreign keys onto it. */
import { beforeAll, describe, expect, it } from "vitest";
import { addFounder, createTestDb, type TestDb } from "@/lib/db/testing/pglite";

let db: TestDb;
const HASH = "$2b$04$abcdefghijklmnopqrstuuJ0Jx1dM8oUu1t8P0bFq4W1d2p3uVZ2e";

beforeAll(async () => {
  db = await createTestDb();
}, 60_000);

describe("users", () => {
  it("stores lower-case, unique emails", async () => {
    await db.query("insert into users (email, password_hash) values ($1, $2)", ["dana@example.com", HASH]);
    expect(await db.fails(`insert into users (email, password_hash) values ('dana@example.com', '${HASH}')`)).toBe(true);
    expect(await db.fails(`insert into users (email, password_hash) values ('Dana@Example.com', '${HASH}')`)).toBe(true);
    expect(await db.fails(`insert into users (email, password_hash) values ('not-an-email', '${HASH}')`)).toBe(true);
  });

  it("only accepts bcrypt hashes, never a plain password", async () => {
    expect(await db.fails(`insert into users (email, password_hash) values ('eve@example.com', 'hunter22')`)).toBe(true);
  });

  it("requires every account to belong to a real user", async () => {
    expect(await db.fails(`insert into accounts (owner_user_id, name) values (gen_random_uuid(), 'orphan')`)).toBe(true);
  });

  it("deletes a user's account (and its ledger) with them, and keeps disputes they opened elsewhere", async () => {
    const { userId, accountId } = await addFounder(db, { stripe: "acct_gone" });
    const session = await db.value<string>(
      `insert into cancel_sessions (account_id, stripe_customer_id, stripe_subscription_id) values ('${accountId}', 'c', 's') returning id`,
    );
    const save = await db.value<string>(
      `insert into saves (account_id, type, cancel_session_id, stripe_customer_id) values ('${accountId}', 'cancel', '${session}', 'c') returning id`,
    );
    // An admin (another user) opened a dispute on it; deleting that admin keeps the dispute.
    const other = await addFounder(db);
    const dispute = await db.value<string>(
      `insert into disputes (save_id, account_id, opened_by, reason) values ('${save}', '${accountId}', '${other.userId}', 'x') returning id`,
    );
    await db.exec(`delete from users where id = '${other.userId}'`);
    expect(await db.value(`select opened_by from disputes where id = '${dispute}'`)).toBeNull();

    await db.exec(`delete from users where id = '${userId}'`);
    expect(await db.count("accounts", `id = '${accountId}'`)).toBe(0);
    expect(await db.count("saves", `id = '${save}'`)).toBe(0);
  });
});
