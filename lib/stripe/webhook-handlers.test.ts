import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const { handleStripeEvent, HANDLED_EVENTS } = await import("./webhook-handlers");

// A Supabase client that fails the test if anything touches the database.
const untouchable = new Proxy({}, {
  get() {
    throw new Error("database should not be touched");
  },
}) as never;

describe("handleStripeEvent routing", () => {
  it("handles exactly the week-1 Connect events", () => {
    expect([...HANDLED_EVENTS].sort()).toEqual(
      [
        "account.application.deauthorized",
        "customer.subscription.created",
        "customer.subscription.deleted",
        "customer.subscription.updated",
        "invoice.paid",
        "invoice.payment_failed",
      ].sort(),
    );
  });

  it("ignores events it doesn't handle without touching the database", async () => {
    const event = { id: "evt_1", type: "charge.succeeded", account: "acct_1", data: { object: {} } };
    await expect(handleStripeEvent(untouchable, event as never)).resolves.toBe("ignored");
  });

  it("ignores platform (non-Connect) events", async () => {
    const event = { id: "evt_2", type: "invoice.paid", data: { object: {} } };
    await expect(handleStripeEvent(untouchable, event as never)).resolves.toBe("ignored");
  });
});
