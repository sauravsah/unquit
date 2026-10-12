import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const { isAuthorizedCron } = await import("./http");

const req = (auth?: string) => new Request("https://app.test/api/cron/dunning", { headers: auth ? { authorization: auth } : {} });

describe("cron auth", () => {
  const secret = "cron-secret-0123456789abcdef";

  it("accepts Vercel Cron's bearer header", () => {
    expect(isAuthorizedCron(req(`Bearer ${secret}`), secret)).toBe(true);
  });

  it("rejects a missing, wrong or differently formatted secret", () => {
    expect(isAuthorizedCron(req(), secret)).toBe(false);
    expect(isAuthorizedCron(req(`Bearer ${secret}x`), secret)).toBe(false);
    expect(isAuthorizedCron(req(secret), secret)).toBe(false);
    expect(isAuthorizedCron(req(`bearer ${secret}`), secret)).toBe(false);
  });
});
