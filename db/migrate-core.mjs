// Applies db/migrations/*.sql in order, each exactly once, recording them in
// schema_migrations. Driver-independent: scripts/migrate.mjs runs it against
// Neon, the tests run it against PGlite.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const MIGRATIONS_DIR = fileURLToPath(new URL("./migrations/", import.meta.url));

// Any fixed number: only one migrate run at a time per database.
const LOCK_KEY = 727_311_001;

/** [{ version: "0001", name: "0001_init.sql", sql, checksum }] sorted by version. */
export function loadMigrations(dir = MIGRATIONS_DIR) {
  return readdirSync(dir)
    .filter((f) => /^\d{4}_[a-z0-9_]+\.sql$/.test(f))
    .sort()
    .map((name) => {
      const sql = readFileSync(join(dir, name), "utf8");
      return { version: name.slice(0, 4), name, sql, checksum: createHash("sha256").update(sql).digest("hex") };
    });
}

/**
 * client.exec(sql)            runs one or more statements (simple query protocol)
 * client.query(sql, params)   runs one statement, returns rows
 * Returns { applied: string[], skipped: string[] }. Safe to run again: applied
 * versions are skipped. Each migration runs in its own transaction.
 */
export async function migrate(client, { migrations = loadMigrations(), log = () => {} } = {}) {
  await client.exec(`
    create table if not exists public.schema_migrations (
      version     text primary key,
      name        text not null,
      checksum    text not null,
      applied_at  timestamptz not null default now()
    );
  `);
  await client.query("select pg_advisory_lock($1)", [LOCK_KEY]);
  try {
    const rows = await client.query("select version, name, checksum from public.schema_migrations");
    const done = new Map(rows.map((r) => [r.version, r]));
    const applied = [];
    const skipped = [];
    for (const m of migrations) {
      const prior = done.get(m.version);
      if (prior) {
        if (prior.checksum !== m.checksum) {
          log(`! ${m.name} changed since it was applied (checksum differs). Not re-running it: add a new migration instead.`);
        }
        skipped.push(m.name);
        continue;
      }
      log(`→ applying ${m.name}`);
      try {
        // The record goes in the same transaction: a crash can never leave a
        // migration applied but unrecorded. (version/name/checksum are
        // [0-9a-z_.] only, checked by loadMigrations, so inlining is safe.)
        await client.exec(
          `begin;\n${m.sql}\n;\ninsert into public.schema_migrations (version, name, checksum) values ('${m.version}', '${m.name}', '${m.checksum}');\ncommit;`,
        );
      } catch (error) {
        await client.exec("rollback;").catch(() => {});
        throw new Error(`Migration ${m.name} failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      applied.push(m.name);
    }
    return { applied, skipped };
  } finally {
    await client.query("select pg_advisory_unlock($1)", [LOCK_KEY]);
  }
}
