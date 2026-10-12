import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const { safeNextPath } = await import("./accounts");

describe("safeNextPath", () => {
  it("keeps same-site paths", () => {
    expect(safeNextPath("/dashboard")).toBe("/dashboard");
    expect(safeNextPath("/dashboard/settings?x=1")).toBe("/dashboard/settings?x=1");
  });

  it("blocks off-site and malformed redirects", () => {
    expect(safeNextPath("https://evil.com")).toBe("/dashboard");
    expect(safeNextPath("//evil.com")).toBe("/dashboard");
    expect(safeNextPath("/\\evil.com")).toBe("/dashboard");
    expect(safeNextPath(null)).toBe("/dashboard");
  });
});
