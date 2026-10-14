import { describe, expect, it } from "vitest";
import { createDodoClient, DodoApiError } from "./client";
import { afterFailure, attemptAt, decideDue, founderDeclineMessage, isHardDecline, MIN_CHARGE_CENTS } from "./policy";
import { sign, verifyWebhook, WebhookVerificationError } from "./webhook-verify";

const T = new Date(Date.UTC(2026, 9, 1, 6, 0, 0));
const day = (n: number) => new Date(T.getTime() + n * 86_400_000);

describe("safe retry policy", () => {
  it("schedules attempts at day 0, +3, +10 and +17, at the same time of day as the first", () => {
    expect([1, 2, 3, 4].map((n) => attemptAt(T, n)!.toISOString())).toEqual([T, day(3), day(10), day(17)].map((d) => d.toISOString()));
    expect(attemptAt(T, 5)).toBeNull();
  });

  it("retries soft declines through attempt 4, then gives up", () => {
    expect(afterFailure(T, 1, "INSUFFICIENT_FUNDS")).toEqual({ kind: "retry", attemptNo: 2, at: day(3) });
    expect(afterFailure(T, 2, "GENERIC_DECLINE")).toEqual({ kind: "retry", attemptNo: 3, at: day(10) });
    expect(afterFailure(T, 3, "DO_NOT_HONOR")).toEqual({ kind: "retry", attemptNo: 4, at: day(17) });
    expect(afterFailure(T, 4, "INSUFFICIENT_FUNDS")).toEqual({ kind: "unpaid", reason: "retries_exhausted" });
  });

  it("never retries hard declines (Dodo's skip list and every 'Hard' code)", () => {
    for (const code of ["STOLEN_CARD", "TRANSACTION_NOT_APPROVED", "FRAUDULENT", "PICKUP_CARD", "AUTHENTICATION_FAILURE", "LOST_CARD", "EXPIRED_CARD", "MANDATE_INVALID"]) {
      expect(isHardDecline(code)).toBe(true);
      expect(afterFailure(T, 1, code)).toEqual({ kind: "unpaid", reason: "hard_decline" });
    }
    expect(isHardDecline("stolen_card")).toBe(true);
    for (const code of ["INSUFFICIENT_FUNDS", "GENERIC_DECLINE", "PROCESSING_ERROR", "NETWORK_TIMEOUT", null, undefined, ""]) expect(isHardDecline(code)).toBe(false);
  });

  it("charges $1 and up, carries smaller amounts forward, and does nothing at $0", () => {
    expect(MIN_CHARGE_CENTS).toBe(100);
    expect(decideDue(0)).toEqual({ kind: "nothing" });
    expect(decideDue(99)).toEqual({ kind: "carry_forward", amountCents: 99 });
    expect(decideDue(100)).toEqual({ kind: "charge", amountCents: 100 });
    expect(decideDue(29_900)).toEqual({ kind: "charge", amountCents: 29_900 });
    expect(() => decideDue(-1)).toThrow(RangeError);
  });

  it("never tells a founder a card was reported stolen or lost", () => {
    for (const code of ["STOLEN_CARD", "LOST_CARD", "PICKUP_CARD", "FRAUDULENT"]) expect(founderDeclineMessage(code)).toBe("Your card was declined.");
    expect(founderDeclineMessage("INSUFFICIENT_FUNDS")).toMatch(/insufficient funds/);
  });
});

describe("Standard Webhooks signature", () => {
  const secret = `whsec_${Buffer.from("a-32-byte-long-test-signing-key!").toString("base64")}`;
  const body = JSON.stringify({ type: "payment.succeeded", data: { payment_id: "pay_1" } });
  const ts = String(Math.floor(T.getTime() / 1000));
  const headers = (signature: string, id = "msg_1", timestamp = ts) => ({ id, timestamp, signature });

  it("accepts a valid v1 signature (with or without the whsec_ prefix, among several)", () => {
    const sig = sign(secret, "msg_1", ts, body);
    expect(() => verifyWebhook(secret, headers(`v1,${sig}`), body, T)).not.toThrow();
    expect(() => verifyWebhook(secret.slice(6), headers(`v1,${sig}`), body, T)).not.toThrow();
    expect(() => verifyWebhook(secret, headers(`v1,bm9wZQ== v2,xyz v1,${sig}`), body, T)).not.toThrow();
  });

  it("rejects a wrong secret, a tampered body, a changed id and missing headers", () => {
    const sig = sign(secret, "msg_1", ts, body);
    const other = `whsec_${Buffer.from("another-32-byte-long-signing-key").toString("base64")}`;
    const reason = (fn: () => void) => {
      try {
        fn();
        return "accepted";
      } catch (e) {
        return (e as WebhookVerificationError).reason;
      }
    };
    expect(reason(() => verifyWebhook(other, headers(`v1,${sig}`), body, T))).toBe("signature");
    expect(reason(() => verifyWebhook(secret, headers(`v1,${sig}`), body.replace("pay_1", "pay_2"), T))).toBe("signature");
    expect(reason(() => verifyWebhook(secret, headers(`v1,${sig}`, "msg_2"), body, T))).toBe("signature");
    expect(reason(() => verifyWebhook(secret, { id: "msg_1", timestamp: ts, signature: null }, body, T))).toBe("missing_headers");
    expect(reason(() => verifyWebhook("int.", headers(`v1,${sig}`), body, T))).toBe("bad_secret");
  });

  it("rejects a replay outside the 5-minute window", () => {
    const old = String(Math.floor(T.getTime() / 1000) - 301);
    const sig = sign(secret, "msg_1", old, body);
    expect(() => verifyWebhook(secret, headers(`v1,${sig}`, "msg_1", old), body, T)).toThrow(/tolerance/);
    const fresh = String(Math.floor(T.getTime() / 1000) - 299);
    expect(() => verifyWebhook(secret, headers(`v1,${sign(secret, "msg_1", fresh, body)}`, "msg_1", fresh), body, T)).not.toThrow();
  });
});

describe("Dodo REST client", () => {
  function recordingFetch(responses: { status: number; body: unknown }[]) {
    const calls: { url: string; method: string; headers: Record<string, string>; body: unknown }[] = [];
    const fetch = async (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => {
      calls.push({ url, method: init.method, headers: init.headers, body: init.body ? JSON.parse(init.body) : undefined });
      const r = responses.shift() ?? { status: 200, body: {} };
      return { ok: r.status < 300, status: r.status, text: async () => JSON.stringify(r.body) };
    };
    return { calls, fetch };
  }

  it("creates an on-demand, mandate-only checkout on the test host", async () => {
    const f = recordingFetch([{ status: 200, body: { session_id: "cks_1", checkout_url: "https://test.checkout.dodopayments.com/session/cks_1" } }]);
    const client = createDodoClient({ apiKey: "sk_test", environment: "test_mode", fetch: f.fetch });
    const out = await client.createCheckoutSession({ productId: "pdt_usage", customer: { email: "a@b.co", name: null }, returnUrl: "https://app/x", metadata: { unquit_account_id: "acc" } });
    expect(out).toEqual({ sessionId: "cks_1", checkoutUrl: "https://test.checkout.dodopayments.com/session/cks_1" });
    expect(f.calls[0]).toMatchObject({
      url: "https://test.dodopayments.com/checkouts",
      method: "POST",
      headers: { Authorization: "Bearer sk_test" },
      body: { product_cart: [{ product_id: "pdt_usage", quantity: 1 }], customer: { email: "a@b.co" }, subscription_data: { on_demand: { mandate_only: true } }, metadata: { unquit_account_id: "acc" } },
    });
  });

  it("charges in USD cents and surfaces Dodo's error code", async () => {
    const f = recordingFetch([
      { status: 200, body: { payment_id: "pay_9" } },
      { status: 400, body: { code: "SUBSCRIPTION_NOT_ON_DEMAND", message: "nope" } },
    ]);
    const client = createDodoClient({ apiKey: "k", environment: "live_mode", fetch: f.fetch });
    expect(await client.chargeSubscription("sub_1", { amountCents: 2500, description: "Unquit fees", metadata: { a: "1" } })).toEqual({ paymentId: "pay_9" });
    expect(f.calls[0]).toMatchObject({ url: "https://live.dodopayments.com/subscriptions/sub_1/charge", body: { product_price: 2500, product_currency: "USD" } });
    const err = await client.chargeSubscription("sub_1", { amountCents: 2500, description: "x", metadata: {} }).catch((e) => e);
    expect(err).toBeInstanceOf(DodoApiError);
    expect(err).toMatchObject({ status: 400, code: "SUBSCRIPTION_NOT_ON_DEMAND", definitelyNotCreated: true });
    await expect(client.chargeSubscription("sub_1", { amountCents: 0, description: "x", metadata: {} })).rejects.toThrow(RangeError);
  });
});
