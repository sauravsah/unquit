import Stripe from "stripe";
import { describe, expect, it } from "vitest";

// Proves the exact verification call used by the webhook route accepts a
// correctly signed payload and rejects a tampered one.
describe("Stripe webhook signature", () => {
  const stripe = new Stripe("sk_test_placeholder");
  const secret = "whsec_test_secret";
  const payload = JSON.stringify({ id: "evt_test", object: "event", type: "invoice.paid", account: "acct_1", data: { object: {} } });

  it("accepts a valid signature", () => {
    const header = stripe.webhooks.generateTestHeaderString({ payload, secret });
    const event = stripe.webhooks.constructEvent(payload, header, secret);
    expect(event.id).toBe("evt_test");
  });

  it("rejects a tampered body", () => {
    const header = stripe.webhooks.generateTestHeaderString({ payload, secret });
    expect(() => stripe.webhooks.constructEvent(payload.replace("acct_1", "acct_2"), header, secret)).toThrow();
  });
});
