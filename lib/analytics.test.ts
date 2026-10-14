import { describe, expect, it } from "vitest";
import { analyticsAllowed } from "./analytics";

describe("analyticsAllowed", () => {
  it("allows the public marketing, sign-in and legal pages", () => {
    for (const p of ["/", "/signup", "/login", "/terms", "/privacy/", "/data-use"]) expect(analyticsAllowed(p)).toBe(true);
  });
  it("blocks the dashboard, admin, card-update pages and setup links", () => {
    for (const p of ["/dashboard", "/dashboard/billing", "/admin", "/u/abc", "/install/uqi_x", "/terms-x"]) expect(analyticsAllowed(p)).toBe(false);
  });
});
