/**
 * The migrator (db/migrate-core.mjs, run by `npm run db:migrate`): order,
 * idempotency, transactions, and that the ported schema is plain Postgres.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadMigrations, migrate } from "@/db/migrate-core.mjs";
import { createTestDb, migrateClient } from "@/lib/db/testing/pglite";

describe("npm run db:migrate", () => {
  it("applies every migration in order, once, recording a checksum for each", async () => {
    const db = await createTestDb({ upTo: null });
    const first = await migrate(migrateClient(db.pg));
    expect(first.applied).toEqual(["0001_init.sql", "0002_cancel_flow.sql", "0003_dunning.sql", "0004_ledger_billing.sql", "0005_auth.sql", "0006_parked_disputes.sql", "0007_install_links.sql", "0008_restricted_key_mode.sql", "0009_dodo_billing.sql"]);
    const recorded = await db.query<{ version: string; checksum: string }>("select version, checksum from schema_migrations order by version");
    expect(recorded.map((r) => r.version)).toEqual(["0001", "0002", "0003", "0004", "0005", "0006", "0007", "0008", "0009"]);
    expect(recorded.map((r) => r.checksum)).toEqual(loadMigrations().map((m) => m.checksum));

    const second = await migrate(migrateClient(db.pg));
    expect(second.applied).toEqual([]);
    expect(second.skipped).toHaveLength(9);
  }, 60_000);

  it("applies only what is new, and warns (without re-running) when an applied file changed", async () => {
    const db = await createTestDb({ upTo: "0003" });
    const all = loadMigrations();
    const edited = all.map((m) => (m.version === "0002" ? { ...m, checksum: "edited" } : m));
    const log: string[] = [];
    const result = await migrate(migrateClient(db.pg), { migrations: edited, log: (l) => log.push(l) });
    expect(result.applied).toEqual(["0004_ledger_billing.sql", "0005_auth.sql", "0006_parked_disputes.sql", "0007_install_links.sql", "0008_restricted_key_mode.sql", "0009_dodo_billing.sql"]);
    expect(log.some((l) => l.includes("0002_cancel_flow.sql changed"))).toBe(true);
  }, 60_000);

  it("rolls a failing migration back completely and doesn't record it", async () => {
    const db = await createTestDb({ upTo: "0005" });
    const bad = { version: "0099", name: "0099_bad.sql", checksum: "x", sql: "create table half_done (id int);\nselect * from no_such_table;" };
    await expect(migrate(migrateClient(db.pg), { migrations: [...loadMigrations(), bad] })).rejects.toThrow(/0099_bad\.sql failed/);
    expect(await db.value("select to_regclass('public.half_done')::text")).toBeNull();
    expect(await db.count("schema_migrations", "version = '0099'")).toBe(0);
    expect(await db.count("schema_migrations")).toBe(9);
    // The lock was released: a fixed run goes through.
    const ok = await migrate(migrateClient(db.pg), {
      migrations: [...loadMigrations(), { ...bad, sql: "create table half_done (id int);" }],
    });
    expect(ok.applied).toEqual(["0099_bad.sql"]);
  }, 60_000);

  it("reads NNNN_name.sql files in order and ignores anything else", () => {
    const dir = mkdtempSync(join(tmpdir(), "uq-migrations-"));
    writeFileSync(join(dir, "0002_b.sql"), "select 2;");
    writeFileSync(join(dir, "0001_a.sql"), "select 1;");
    writeFileSync(join(dir, "README.md"), "not sql");
    writeFileSync(join(dir, "draft.sql"), "select 3;");
    expect(loadMigrations(dir).map((m) => m.name)).toEqual(["0001_a.sql", "0002_b.sql"]);
  });

  it("leaves no Supabase-specific bits behind: no RLS, policies, auth schema or auth.uid() helpers", async () => {
    const db = await createTestDb();
    expect(await db.count("pg_class c join pg_namespace n on n.oid = c.relnamespace", "n.nspname = 'public' and c.relrowsecurity")).toBe(0);
    expect(await db.count("pg_policies")).toBe(0);
    expect(await db.count("pg_namespace", "nspname = 'auth'")).toBe(0);
    for (const fn of ["is_account_owner", "rotate_widget_signing_secret"]) {
      expect(await db.count("pg_proc", `proname = '${fn}'`)).toBe(0);
    }
    for (const m of loadMigrations()) {
      const code = m.sql.replace(/--.*$/gm, "");
      expect(code).not.toMatch(/auth\.(users|uid)|row level security|create policy|supabase_realtime|to authenticated/i);
    }
  }, 60_000);
});
