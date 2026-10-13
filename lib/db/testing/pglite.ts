/**
 * Tests: a real Postgres (PGlite, in-memory WASM) behind the same `Db`
 * interface the app uses, with the migrations applied by the real migrator.
 */
import { PGlite } from "@electric-sql/pglite";
import { loadMigrations, migrate, type MigrateClient } from "@/db/migrate-core.mjs";
import { TYPE_PARSERS, serializeParams, type Db } from "../core";

export type TestDb = Db & {
  pg: PGlite;
  /** Runs one or more statements (no parameters). */
  exec(sql: string): Promise<void>;
  /** True when the statement(s) fail. */
  fails(sql: string): Promise<boolean>;
  /** The first column of the first row. */
  value<T = unknown>(sql: string, params?: unknown[]): Promise<T>;
  count(table: string, where?: string): Promise<number>;
};

export function pgliteParsers(): Record<number, (value: string) => unknown> {
  return Object.fromEntries(Object.entries(TYPE_PARSERS).map(([oid, fn]) => [Number(oid), (v: string) => fn(v)]));
}

export function migrateClient(pg: PGlite): MigrateClient {
  return {
    exec: (sql) => pg.exec(sql),
    query: async <T>(sql: string, params?: unknown[]) => (await pg.query<T>(sql, params)).rows,
  };
}

/** Applies migrations up to and including `upTo` (e.g. "0003"); all of them by default. */
export async function migrateTo(db: TestDb, upTo?: string) {
  const migrations = loadMigrations().filter((m) => !upTo || m.version <= upTo);
  return migrate(migrateClient(db.pg), { migrations });
}

/** A fresh database, migrated (through `upTo`, or fully). `upTo: null` = no schema at all. */
export async function createTestDb(opts: { upTo?: string | null } = {}): Promise<TestDb> {
  const pg = new PGlite({ parsers: pgliteParsers() });
  const db: TestDb = {
    pg,
    async query<T>(text: string, params: readonly unknown[] = []) {
      return (await pg.query<T>(text, serializeParams(params))).rows;
    },
    async exec(sql: string) {
      await pg.exec(sql);
    },
    async fails(sql: string) {
      try {
        await pg.exec(sql);
        return false;
      } catch {
        return true;
      }
    },
    async value<T>(sql: string, params: unknown[] = []) {
      const rows = await db.query<Record<string, unknown>>(sql, params);
      const row = rows[0];
      return (row ? Object.values(row)[0] : undefined) as T;
    },
    async count(table: string, where = "true") {
      return Number(await db.value(`select count(*) from ${table} where ${where}`));
    },
  };
  if (opts.upTo !== null) await migrateTo(db, opts.upTo);
  return db;
}

let seq = 0;

/** A user + their founder account. `stripe` = a connected Stripe account id. */
export async function addFounder(db: TestDb, opts: { email?: string; name?: string; stripe?: string | null } = {}) {
  seq++;
  const email = opts.email ?? `founder${seq}@example.com`;
  const userId = await db.value<string>("insert into users (email, password_hash) values ($1, $2) returning id", [
    email,
    "$2b$04$abcdefghijklmnopqrstuuJ0Jx1dM8oUu1t8P0bFq4W1d2p3uVZ2e",
  ]);
  const accountId = await db.value<string>(
    `insert into accounts (owner_user_id, name, stripe_account_id, stripe_connection_status, stripe_connected_at)
     values ($1, $2, $3, $4, $5) returning id`,
    [userId, opts.name ?? email, opts.stripe ?? null, opts.stripe ? "connected" : "not_connected", opts.stripe ? "2026-09-01T00:00:00.000Z" : null],
  );
  return { userId, accountId, email };
}
