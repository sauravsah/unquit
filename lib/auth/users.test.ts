import { beforeAll, describe, expect, it, vi } from "vitest";
import { createTestDb, type TestDb } from "@/lib/db/testing/pglite";

vi.mock("server-only", () => ({}));
const { EmailTakenError, createUser, normalizeEmail, signUpErrors, verifyCredentials } = await import("./users");

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
}, 60_000);

describe("sign-up validation", () => {
  it("normalises emails and rejects junk", () => {
    expect(normalizeEmail("  Dana@Example.COM ")).toBe("dana@example.com");
    expect(normalizeEmail("dana@localhost")).toBeNull();
    expect(normalizeEmail(42)).toBeNull();
  });

  it("asks for a valid email and an 8-72 character password", () => {
    expect(signUpErrors({ email: "dana@example.com", password: "correct horse" })).toEqual([]);
    expect(signUpErrors({ email: "nope", password: "short" })).toEqual([
      "Enter a valid email address.",
      "Use at least 8 characters for your password.",
    ]);
    expect(signUpErrors({ email: "dana@example.com", password: "x".repeat(73) })).toEqual(["Keep your password under 72 characters."]);
  });
});

describe("users", () => {
  it("creates a login with a bcrypt hash, never the password itself", async () => {
    const user = await createUser(db, { email: "Dana@Example.com", password: "correct horse battery" });
    expect(user.email).toBe("dana@example.com");
    const hash = await db.value<string>("select password_hash from users where id = $1", [user.id]);
    expect(hash).toMatch(/^\$2[aby]\$12\$/);
    expect(hash).not.toContain("correct horse");
  });

  it("refuses a second account for the same email, whatever its case", async () => {
    await expect(createUser(db, { email: "DANA@example.com", password: "another password" })).rejects.toBeInstanceOf(EmailTakenError);
  });

  it("signs in with the right password only, and records the sign-in", async () => {
    expect(await verifyCredentials(db, "dana@example.com", "wrong password")).toBeNull();
    expect(await verifyCredentials(db, "nobody@example.com", "correct horse battery")).toBeNull();
    expect(await verifyCredentials(db, "dana@example.com", "")).toBeNull();
    const user = await verifyCredentials(db, " DANA@example.com", "correct horse battery");
    expect(user?.email).toBe("dana@example.com");
    expect(await db.value("select last_sign_in_at is not null from users where email = 'dana@example.com'")).toBe(true);
  });
});
