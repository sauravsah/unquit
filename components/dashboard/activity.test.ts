import { describe, expect, it } from "vitest";
import { buildActivity, timeAgo } from "./activity";

describe("buildActivity", () => {
  it("merges saves, sessions and cases newest first and skips duplicates", () => {
    const items = buildActivity(
      [
        { id: "s1", type: "cancel", status: "verified", stripe_customer_id: "cus_1", saved_mrr_cents: 4900, currency: "usd", receipt_number: "UQ-0001000", created_at: "2026-10-01T00:00:00Z", verified_at: "2026-10-05T00:00:00Z" },
        { id: "s2", type: "dunning", status: "verified", stripe_customer_id: "cus_2", saved_mrr_cents: 0, currency: "usd", receipt_number: "UQ-0001001", created_at: "2026-10-06T00:00:00Z", verified_at: "2026-10-06T00:00:00Z" },
      ],
      [
        { id: "c1", status: "canceled", reason: "too_expensive", reason_label: "Too expensive", stripe_customer_id: "cus_3", mrr_at_start_cents: 2900, started_at: "2026-10-03T00:00:00Z" },
        { id: "c2", status: "offer_accepted", reason: null, reason_label: null, stripe_customer_id: "cus_1", mrr_at_start_cents: 4900, started_at: "2026-10-01T00:00:00Z" },
      ],
      [
        { id: "d1", status: "recovered", customer_name: "Ada", customer_email: null, stripe_customer_id: "cus_4", amount_due_cents: 9900, recovered_amount_cents: 9900, recovered_via: "update_link", currency: "usd", opened_at: "2026-10-02T00:00:00Z", recovered_at: "2026-10-07T00:00:00Z" },
      ],
    );
    expect(items.map((i) => i.kind)).toEqual(["recovery", "save", "cancel"]);
    expect(items[0]!.title).toBe("Payment recovered by unquit");
    expect(items[1]!.amountCents).toBe(4900);
    expect(items[2]!.detail).toContain("Too expensive");
  });

  it("respects the limit", () => {
    const sessions = Array.from({ length: 30 }, (_, i) => ({
      id: `c${i}`,
      status: "started",
      reason: null,
      reason_label: null,
      stripe_customer_id: "cus_x",
      mrr_at_start_cents: null,
      started_at: new Date(Date.UTC(2026, 9, 1, i)).toISOString(),
    }));
    expect(buildActivity([], sessions, [], 5)).toHaveLength(5);
  });
});

describe("timeAgo", () => {
  const now = Date.parse("2026-10-12T12:00:00Z");
  it("formats relative times", () => {
    expect(timeAgo("2026-10-12T11:59:40Z", now)).toBe("just now");
    expect(timeAgo("2026-10-12T11:15:00Z", now)).toBe("45m ago");
    expect(timeAgo("2026-10-12T07:00:00Z", now)).toBe("5h ago");
    expect(timeAgo("2026-10-10T12:00:00Z", now)).toBe("2d ago");
  });
});
