import "server-only";
import { neon, types as pgTypes } from "@neondatabase/serverless";
import { serverEnv } from "@/lib/env";
import { TYPE_PARSERS, serializeParams, type Db } from "./core";

export * from "./core";

/**
 * The app's database: Neon's serverless HTTP driver (one HTTPS round trip per
 * query, no connection pool to manage on Vercel). Reads DATABASE_URL, falling
 * back to POSTGRES_URL (both set by Vercel's Neon integration).
 *
 * There is no row-level security: every founder-facing query filters by the
 * signed-in account id itself. Webhooks, cron and the public widget resolve
 * the account first (Stripe account id, publishable key, signed link) and
 * scope by it the same way.
 */

const typeConfig = {
  getTypeParser: (oid: number, format?: "text" | "binary") =>
    TYPE_PARSERS[oid] ?? (pgTypes.getTypeParser as (oid: number, format?: "text" | "binary") => unknown)(oid, format),
};

let cached: Db | null = null;
let override: Db | null = null;

export function createNeonDb(connectionString: string): Db {
  const sql = neon(connectionString);
  // `types` must go on each query: the HTTP driver ignores it in neon()'s defaults.
  const opts = { types: typeConfig as never };
  return {
    async query<T>(text: string, params: readonly unknown[] = []) {
      return (await sql.query(text, serializeParams(params), opts)) as T[];
    },
  };
}

/** The shared database client (created on first use, so builds need no secrets). */
export function getDb(): Db {
  if (override) return override;
  if (!cached) cached = createNeonDb(serverEnv.databaseUrl());
  return cached;
}

/** Tests only: route getDb() to another implementation (e.g. PGlite). */
export function setDbForTesting(db: Db | null): void {
  override = db;
}
