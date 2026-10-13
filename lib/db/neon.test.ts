/**
 * The production driver path (Neon's HTTP API) with fetch stubbed: what we
 * send, and how column values come back. Guards the type parsing that every
 * repo relies on (int8 -> number, timestamptz -> ISO string, date -> "YYYY-MM-DD").
 */
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const { createNeonDb } = await import("./index");

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("createNeonDb (Neon HTTP driver)", () => {
  it("sends parameterised SQL as text and parses money, timestamps, dates, json, arrays and booleans", async () => {
    const calls: { url: string; body: { query: string; params: unknown[] } }[] = [];
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      calls.push({ url: String(url), body: JSON.parse(String(init.body)) });
      return new Response(
        JSON.stringify({
          command: "SELECT",
          rowCount: 1,
          fields: [
            { name: "fee_cents", dataTypeID: 20 },
            { name: "verified_at", dataTypeID: 1184 },
            { name: "billing_month", dataTypeID: 1082 },
            { name: "offer", dataTypeID: 3802 },
            { name: "schedule_days", dataTypeID: 1007 },
            { name: "enabled", dataTypeID: 16 },
            { name: "total", dataTypeID: 1700 },
          ],
          rows: [["29900", "2026-10-01 09:30:00.123+00", "2026-10-01", '{"type":"pause","months":1}', "{0,3,7}", "t", "123"]],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;

    const db = createNeonDb("postgresql://user:pw@ep-test-123456.us-east-2.aws.neon.tech/neondb?sslmode=require");
    const rows = await db.query("select * from saves where account_id = $1 and status = any($2) and created_at >= $3", [
      "acc_1",
      ["verified", "disputed"],
      new Date("2026-10-01T00:00:00.000Z"),
    ]);

    expect(calls[0]!.url).toMatch(/^https:\/\/api\..*neon\.tech\/sql$/);
    expect(calls[0]!.body.params).toEqual(["acc_1", '{"verified","disputed"}', "2026-10-01T00:00:00.000Z"]);
    expect(rows).toEqual([
      {
        fee_cents: 29900,
        verified_at: "2026-10-01T09:30:00.123Z",
        billing_month: "2026-10-01",
        offer: { type: "pause", months: 1 },
        schedule_days: [0, 3, 7],
        enabled: true,
        total: 123,
      },
    ]);
  });

  it("surfaces Postgres errors with their SQLSTATE code (unique violations drive idempotency)", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ message: 'duplicate key value violates unique constraint "users_email_key"', code: "23505" }), {
        status: 400,
        headers: { "content-type": "application/json" },
      })) as typeof fetch;
    const db = createNeonDb("postgresql://user:pw@ep-test-123456.us-east-2.aws.neon.tech/neondb");
    await expect(db.query("insert into users (email, password_hash) values ($1, $2)", ["a@b.co", "$2b$x"])).rejects.toMatchObject({ code: "23505" });
  });
});
