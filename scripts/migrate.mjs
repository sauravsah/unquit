#!/usr/bin/env node
// npm run db:migrate
//
// Applies db/migrations/*.sql to the Neon database in order, once each
// (tracked in schema_migrations). Safe to run any number of times.
//
// Connection string, first one set wins:
//   DATABASE_URL_UNPOOLED  (direct connection: best for DDL; set by Vercel's Neon integration)
//   DATABASE_URL           (pooled is fine too)
//   POSTGRES_URL
// Reads .env.local / .env when present, so locally `npm run db:migrate` just works.
//
// Optional: `npm run db:migrate -- --to 0004` stops after that version.
import { existsSync } from "node:fs";
import { Pool, neonConfig } from "@neondatabase/serverless";
import { loadMigrations, migrate } from "../db/migrate-core.mjs";

for (const file of [".env.local", ".env"]) {
  if (existsSync(file) && typeof process.loadEnvFile === "function") process.loadEnvFile(file);
}

const pick = (...names) => names.map((n) => [n, process.env[n]]).find(([, v]) => v && v.trim() !== "");
const found = pick("DATABASE_URL_UNPOOLED", "DATABASE_URL", "POSTGRES_URL");
if (!found) {
  console.error("No database configured: set DATABASE_URL (or DATABASE_URL_UNPOOLED / POSTGRES_URL). See .env.example.");
  process.exit(1);
}
const [source, connectionString] = found;

const toArg = process.argv.find((a) => a.startsWith("--to"));
const toIndex = process.argv.indexOf("--to");
const upTo = toArg?.includes("=") ? toArg.split("=")[1] : toIndex >= 0 ? process.argv[toIndex + 1] : undefined;
if (upTo !== undefined && !/^\d{4}$/.test(upTo)) {
  console.error("--to needs a 4-digit migration version, e.g. --to 0004");
  process.exit(1);
}
const migrations = loadMigrations().filter((m) => !upTo || m.version <= upTo);

if (!neonConfig.webSocketConstructor && typeof globalThis.WebSocket === "function") {
  neonConfig.webSocketConstructor = globalThis.WebSocket;
}

const pool = new Pool({ connectionString });
const conn = await pool.connect();
const client = {
  exec: (sql) => conn.query(sql),
  query: async (sql, params) => (await conn.query(sql, params)).rows,
};

try {
  const host = new URL(connectionString).host;
  console.log(`Migrating ${host} (from ${source})`);
  const { applied, skipped } = await migrate(client, { migrations, log: (line) => console.log(line) });
  console.log(applied.length ? `✓ applied ${applied.length}: ${applied.join(", ")}` : "✓ already up to date");
  if (skipped.length) console.log(`  (${skipped.length} already applied)`);
} catch (error) {
  console.error(`✗ ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  conn.release();
  await pool.end();
}
