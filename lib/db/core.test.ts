import { describe, expect, it } from "vitest";
import { dbFail, insertStatement, json, pgTimestampToIso, prefixColumns, serializeParam, updateStatement, upsertStatement } from "./core";

describe("parameters", () => {
  it("sends everything as text so Neon and PGlite behave the same", () => {
    expect(serializeParam(null)).toBeNull();
    expect(serializeParam(undefined)).toBeNull();
    expect(serializeParam(4900)).toBe("4900");
    expect(serializeParam(true)).toBe("true");
    expect(serializeParam(new Date("2026-10-01T09:30:00.000Z"))).toBe("2026-10-01T09:30:00.000Z");
    expect(serializeParam(["verified", 'say "hi"', null])).toBe('{"verified","say \\"hi\\"",NULL}');
    expect(serializeParam({ type: "pause", months: 1 })).toBe('{"type":"pause","months":1}');
    expect(serializeParam(json([{ id: "too_expensive" }]))).toBe('[{"id":"too_expensive"}]');
  });
});

describe("column values", () => {
  it("turns Postgres timestamps into ISO strings", () => {
    expect(pgTimestampToIso("2026-10-01 09:30:00.123+00")).toBe("2026-10-01T09:30:00.123Z");
    expect(pgTimestampToIso("2026-10-01 15:00:00+05:30")).toBe("2026-10-01T09:30:00.000Z");
    expect(pgTimestampToIso("2026-10-01 09:30:00.123456+00")).toBe("2026-10-01T09:30:00.123Z");
    expect(pgTimestampToIso("2026-10-01 09:30:00", false)).toBe("2026-10-01T09:30:00.000Z");
  });
});

describe("statement builders", () => {
  it("builds inserts, leaving out undefined columns and sending jsonb columns as JSON", () => {
    const s = insertStatement(
      "saves",
      { account_id: "a", offer: { type: "discount" }, note: undefined, cancel_session_id: null },
      { onConflictDoNothing: "cancel_session_id", returning: "id" },
    );
    expect(s.text).toBe("insert into saves (account_id, offer, cancel_session_id) values ($1, $2, $3) on conflict (cancel_session_id) do nothing returning id");
    expect(s.params.map(serializeParam)).toEqual(["a", '{"type":"discount"}', null]);
    // flows.reasons is a jsonb ARRAY: it must not become a Postgres array literal.
    expect(serializeParam(insertStatement("flows", { reasons: [{ id: "x" }] }).params[0])).toBe('[{"id":"x"}]');
  });

  it("builds compare-and-set updates: null -> is null, arrays -> any()", () => {
    const s = updateStatement("saves", { status: "verified", fee_cents: 0 }, { id: "s1", status: ["pending", "disputed"], ended_at: null }, { returning: "id" });
    expect(s.text).toBe("update saves set status = $1, fee_cents = $2 where id = $3 and status = any($4) and ended_at is null returning id");
    expect(s.params).toEqual(["verified", 0, "s1", ["pending", "disputed"]]);
  });

  it("refuses an update without a where clause or with a bad identifier", () => {
    expect(() => updateStatement("saves", { status: "lost" }, {})).toThrow(/without a where clause/);
    expect(() => updateStatement("saves; drop table x", { status: "lost" }, { id: 1 })).toThrow(/identifier/);
  });

  it("builds upserts that replace every non-key column", () => {
    const s = upsertStatement("flows", { account_id: "a", template: "balanced", reasons: [] }, ["account_id"]);
    expect(s.text).toBe(
      "insert into flows (account_id, template, reasons) values ($1, $2, $3) on conflict (account_id) do update set template = excluded.template, reasons = excluded.reasons",
    );
  });

  it("prefixes column lists for joins", () => {
    expect(prefixColumns("id, account_id,status", "c")).toBe("c.id, c.account_id, c.status");
  });

  it("wraps driver errors but keeps the SQLSTATE code", () => {
    const err = Object.assign(new Error("duplicate key value"), { code: "23505" });
    expect(() => dbFail("Opening dispute", err)).toThrow("Opening dispute failed: duplicate key value");
    try {
      dbFail("x", err);
    } catch (e) {
      expect((e as { code?: string }).code).toBe("23505");
    }
  });
});
