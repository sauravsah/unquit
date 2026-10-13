/**
 * The database layer's driver-independent half: the tiny `Db` interface every
 * repo talks to, how parameters are sent and how column values come back.
 *
 * Production wires it to Neon's serverless HTTP driver (lib/db/index.ts);
 * tests wire the same interface to PGlite, an in-memory Postgres, running the
 * real migrations (lib/db/testing/pglite.ts). Nothing in here knows which.
 *
 * Conventions every query in the app follows:
 *   * plain SQL with $1, $2 … placeholders (never string-built values);
 *   * money is int8 and comes back as a JS number (cents);
 *   * timestamptz comes back as an ISO-8601 string ("2026-10-01T09:30:00.000Z"),
 *     date as "YYYY-MM-DD", jsonb as parsed JSON;
 *   * founder-facing reads always filter by the signed-in account id
 *     (tenant isolation lives here now that there is no RLS).
 */

export type Row = Record<string, unknown>;

export interface Db {
  /** Runs one statement and returns its rows (empty for statements without RETURNING). */
  query<T = Row>(text: string, params?: readonly unknown[]): Promise<T[]>;
}

/** Postgres SQLSTATE for a unique-constraint violation. */
export const UNIQUE_VIOLATION = "23505";

export function errorCode(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : undefined;
}

export function isUniqueViolation(error: unknown): boolean {
  return errorCode(error) === UNIQUE_VIOLATION;
}

/** Marks a value to be sent as JSON (for jsonb columns), whatever its shape. */
export class JsonValue {
  constructor(readonly value: unknown) {}
}
export const json = (value: unknown) => new JsonValue(value);

/** jsonb columns in the schema: insert/update helpers send these as JSON, not as Postgres arrays. */
export const JSON_COLUMNS = new Set(["offer_shown", "offer", "reasons", "templates", "detail", "evidence"]);

function arrayLiteral(values: readonly unknown[]): string {
  const items = values.map((v) => {
    if (v === null || v === undefined) return "NULL";
    if (Array.isArray(v)) return arrayLiteral(v);
    const s = v instanceof Date ? v.toISOString() : String(v);
    return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  });
  return `{${items.join(",")}}`;
}

/**
 * Every parameter is sent as text (or NULL), so both drivers behave the same:
 * arrays become Postgres array literals, plain objects and json() become JSON,
 * Dates become ISO strings.
 */
export function serializeParam(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof JsonValue) return value.value === undefined ? null : JSON.stringify(value.value);
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return arrayLiteral(value);
  if (typeof value === "object") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  return String(value);
}

export function serializeParams(params: readonly unknown[] = []): (string | null)[] {
  return params.map(serializeParam);
}

/** "2026-10-01 09:30:00.123+00" (Postgres text) -> "2026-10-01T09:30:00.123Z". */
export function pgTimestampToIso(text: string, withZone = true): string {
  if (text === "infinity" || text === "-infinity") return text;
  let s = text.trim().replace(" ", "T");
  if (withZone) {
    // +HH, +HHMM or +HH:MM -> +HH:MM
    s = s.replace(/([+-])(\d{2}):?(\d{2})?(?::?(\d{2}))?$/, (_m, sign: string, hh: string, mm?: string) => `${sign}${hh}:${mm ?? "00"}`);
  } else if (!/[zZ]|[+-]\d{2}(:?\d{2})?$/.test(s)) {
    s += "Z";
  }
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? text : d.toISOString();
}

const toNumber = (text: string) => Number(text);

/** Postgres type oid -> text parser. Anything not listed keeps the driver's default. */
export const TYPE_PARSERS: Record<number, (text: string) => unknown> = {
  20: toNumber, // int8 (money in cents, counts)
  1700: toNumber, // numeric (sum() of int8)
  1184: (t) => pgTimestampToIso(t, true), // timestamptz
  1114: (t) => pgTimestampToIso(t, false), // timestamp
  1082: (t) => t, // date stays "YYYY-MM-DD"
};

// ---------------------------------------------------------------------------
// Small query helpers
// ---------------------------------------------------------------------------

/** First row or null. */
export async function queryOne<T = Row>(db: Db, text: string, params?: readonly unknown[]): Promise<T | null> {
  const rows = await db.query<T>(text, params);
  return rows[0] ?? null;
}

/** "a, b, c" -> "s.a, s.b, s.c" (for joins). */
export function prefixColumns(columns: string, alias: string): string {
  return columns
    .split(",")
    .map((c) => `${alias}.${c.trim()}`)
    .join(", ");
}

function columnValue(column: string, value: unknown): unknown {
  if (value instanceof JsonValue) return value;
  return JSON_COLUMNS.has(column) && value !== null && value !== undefined ? json(value) : value;
}

const IDENT = /^[a-z_][a-z0-9_]*$/;
function ident(name: string): string {
  if (!IDENT.test(name)) throw new Error(`Bad SQL identifier: ${name}`);
  return name;
}

export type Statement = { text: string; params: unknown[] };

/**
 * insert into <table> (<keys>) values (...) [on conflict (<target>) do nothing] [returning ...].
 * Undefined values are left out (column default applies).
 */
export function insertStatement(
  table: string,
  row: Record<string, unknown>,
  opts: { onConflictDoNothing?: string; returning?: string } = {},
): Statement {
  const entries = Object.entries(row).filter(([, v]) => v !== undefined);
  const params = entries.map(([k, v]) => columnValue(k, v));
  const cols = entries.map(([k]) => ident(k)).join(", ");
  const values = entries.map((_, i) => `$${i + 1}`).join(", ");
  let text = `insert into ${ident(table)} (${cols}) values (${values})`;
  if (opts.onConflictDoNothing) text += ` on conflict (${opts.onConflictDoNothing}) do nothing`;
  if (opts.returning) text += ` returning ${opts.returning}`;
  return { text, params };
}

/**
 * update <table> set ... where <filters> [returning ...]. Filters: null -> "is null",
 * array -> "= any($n)", anything else -> "= $n". `extraWhere` is raw SQL using the
 * placeholders after the generated ones (see `nextParam`).
 */
export function updateStatement(
  table: string,
  patch: Record<string, unknown>,
  where: Record<string, unknown>,
  opts: { returning?: string; extraWhere?: (nextParam: (value: unknown) => string) => string } = {},
): Statement {
  const params: unknown[] = [];
  const next = (value: unknown) => {
    params.push(value);
    return `$${params.length}`;
  };
  const sets = Object.entries(patch)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${ident(k)} = ${next(columnValue(k, v))}`);
  if (sets.length === 0) throw new Error(`updateStatement(${table}): nothing to set`);
  const conds = Object.entries(where).map(([k, v]) => {
    if (v === null) return `${ident(k)} is null`;
    if (Array.isArray(v)) return `${ident(k)} = any(${next(v)})`;
    return `${ident(k)} = ${next(v)}`;
  });
  if (opts.extraWhere) conds.push(`(${opts.extraWhere(next)})`);
  if (conds.length === 0) throw new Error(`updateStatement(${table}): refusing to update without a where clause`);
  let text = `update ${ident(table)} set ${sets.join(", ")} where ${conds.join(" and ")}`;
  if (opts.returning) text += ` returning ${opts.returning}`;
  return { text, params };
}

/** insert ... on conflict (<conflict>) do update set <every other column> = excluded.<column>. */
export function upsertStatement(table: string, row: Record<string, unknown>, conflict: string[], opts: { returning?: string } = {}): Statement {
  const base = insertStatement(table, row);
  const updates = Object.keys(row)
    .filter((k) => row[k] !== undefined && !conflict.includes(k))
    .map((k) => `${ident(k)} = excluded.${ident(k)}`);
  let text = `${base.text} on conflict (${conflict.map(ident).join(", ")}) do ${updates.length ? `update set ${updates.join(", ")}` : "nothing"}`;
  if (opts.returning) text += ` returning ${opts.returning}`;
  return { text, params: base.params };
}

export async function run<T = Row>(db: Db, s: Statement): Promise<T[]> {
  return db.query<T>(s.text, s.params);
}

/** Wraps a driver error with what we were doing, keeping its SQLSTATE `code`. */
export function dbFail(what: string, error: unknown): never {
  const message = error instanceof Error ? error.message : String(error);
  const wrapped = new Error(`${what} failed: ${message}`) as Error & { code?: string };
  const code = errorCode(error);
  if (code) wrapped.code = code;
  throw wrapped;
}

/** Runs `fn`, re-throwing any error as "<what> failed: …". */
export async function attempt<T>(what: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    dbFail(what, error);
  }
}
