import { describe, expect, it, vi } from "vitest";
import {
  KEY_MODE_WEBHOOK_EVENTS,
  KeyValidationError,
  REQUIRED_PERMISSIONS,
  checkPublishableKey,
  classifyKey,
  validateRestrictedKey,
  verifyPublishableKeyMatches,
  type PermissionId,
} from "./restricted-key";
import { fakeStripe, stripeErrors, type FakeHandlers } from "./testing/fake-stripe";

vi.mock("server-only", () => ({}));
const { HANDLED_EVENTS } = await import("./webhook-handlers");

const RK = "rk_test_51Abcdefghijklmnopqrstuvwxyz0123456789WXYZ";

/** Which Stripe call each permission's probe makes. */
const PROBE_METHOD: Record<PermissionId, string> = {
  customer_write: "customers.update",
  setup_intent_write: "setupIntents.update",
  payment_intent_read: "paymentIntents.list",
  charge_read: "charges.list",
  product_read: "products.list",
  subscription_write: "subscriptions.update",
  invoice_write: "invoices.update",
  coupon_write: "coupons.update",
  plan_read: "prices.list",
  webhook_write: "webhookEndpoints.update",
};

/** A key with these permissions: probes on write ids 404, lists return empty, the rest 403. */
function keyWith(granted: PermissionId[], opts: { accountRead?: boolean; acct?: string } = {}) {
  const acct = opts.acct ?? "acct_founder";
  const h: FakeHandlers = {
    "accounts.retrieveCurrent": () => {
      if (opts.accountRead) return { id: acct };
      throw stripeErrors.permission("connected_account_read", acct);
    },
  };
  for (const p of REQUIRED_PERMISSIONS) {
    const method = PROBE_METHOD[p.id];
    h[method] = () => {
      if (!granted.includes(p.id)) throw stripeErrors.permission(p.id, acct);
      if (method.endsWith(".list")) return { data: [] };
      throw stripeErrors.missing();
    };
  }
  return fakeStripe(h, "founder");
}

const ALL = REQUIRED_PERMISSIONS.map((p) => p.id);

describe("REQUIRED_PERMISSIONS", () => {
  it("covers every Stripe call Unquit makes on a founder's account", () => {
    expect(ALL.sort()).toEqual(
      ["charge_read", "coupon_write", "customer_write", "invoice_write", "payment_intent_read", "plan_read", "product_read", "setup_intent_write", "subscription_write", "webhook_write"].sort(),
    );
  });

  it("the key-mode webhook listens to the Connect webhook's events except the Connect-only one", () => {
    expect([...KEY_MODE_WEBHOOK_EVENTS].sort()).toEqual([...HANDLED_EVENTS].filter((e) => e !== "account.application.deauthorized").sort());
  });

  it("probes never write: write probes only update ids that cannot exist, with no fields", async () => {
    const f = keyWith(ALL);
    await validateRestrictedKey(RK, f.client);
    for (const c of f.calls.filter((c) => c.method.endsWith(".update"))) {
      expect(String(c.args[0])).toContain("unquit_probe_does_not_exist");
      expect(c.args[1]).toEqual({});
    }
    expect(f.methods().some((m) => /\.(create|del|cancel|pay)$/.test(m))).toBe(false);
  });
});

describe("classifyKey", () => {
  it("tells restricted, secret and publishable keys apart", () => {
    expect(classifyKey(RK)).toEqual({ kind: "restricted", livemode: false });
    expect(classifyKey("rk_live_51Abcdefghijkl")).toEqual({ kind: "restricted", livemode: true });
    expect(classifyKey("sk_live_51Abc")).toEqual({ kind: "secret" });
    expect(classifyKey("pk_test_51Abc")).toEqual({ kind: "publishable" });
    expect(classifyKey("whsec_123")).toEqual({ kind: "invalid" });
    expect(classifyKey("rk_test_short")).toEqual({ kind: "invalid" });
  });
});

describe("validateRestrictedKey", () => {
  it("accepts a key with every permission and finds the account from the permission error (no Accounts: Read)", async () => {
    const f = keyWith(ALL, { acct: "acct_1PZz" });
    await expect(validateRestrictedKey(` ${RK} `, f.client)).resolves.toEqual({ accountId: "acct_1PZz", livemode: false, keyLast4: "WXYZ" });
  });

  it("uses GET /v1/account when the key may read it", async () => {
    const f = keyWith(ALL, { accountRead: true, acct: "acct_direct" });
    await expect(validateRestrictedKey(RK, f.client)).resolves.toMatchObject({ accountId: "acct_direct" });
  });

  it("names every missing permission", async () => {
    const f = keyWith(ALL.filter((p) => p !== "coupon_write" && p !== "webhook_write"));
    const err = await validateRestrictedKey(RK, f.client).catch((e) => e);
    expect(err).toBeInstanceOf(KeyValidationError);
    expect(err.code).toBe("missing_permissions");
    expect(err.missing.map((p: { id: string }) => p.id).sort()).toEqual(["coupon_write", "webhook_write"]);
    expect(err.message).toContain("Coupons: Write");
    expect(err.message).toContain("Webhook Endpoints: Write");
  });

  it("rejects secret keys (sk_) and publishable keys without calling Stripe", async () => {
    const f = fakeStripe({}, "none");
    await expect(validateRestrictedKey("sk_live_51Abcdefghijklmnop", f.client)).rejects.toMatchObject({ code: "secret_key" });
    await expect(validateRestrictedKey("pk_live_51Abcdefghijklmnop", f.client)).rejects.toMatchObject({ code: "publishable_key" });
    await expect(validateRestrictedKey("hello", f.client)).rejects.toMatchObject({ code: "not_restricted" });
    expect(f.calls).toHaveLength(0);
  });

  it("reports a key Stripe doesn't recognise", async () => {
    const f = fakeStripe({ "accounts.retrieveCurrent": () => { throw stripeErrors.auth(); } });
    await expect(validateRestrictedKey(RK, f.client)).rejects.toMatchObject({ code: "invalid_key" });
  });

  it("reports Stripe being unreachable instead of a wrong permission", async () => {
    const f = keyWith(ALL);
    const down = fakeStripe({ ...Object.fromEntries(Object.values(PROBE_METHOD).map((m) => [m, () => { throw Object.assign(new Error("ECONNRESET"), { type: "StripeConnectionError" }); }])), "accounts.retrieveCurrent": () => ({ id: "acct_x" }) });
    await expect(validateRestrictedKey(RK, down.client)).rejects.toMatchObject({ code: "stripe_unreachable" });
    expect(f.calls).toHaveLength(0);
  });
});

describe("publishable key", () => {
  it("must be a pk_ in the same mode as the restricted key", () => {
    expect(checkPublishableKey(" pk_test_51Abcdefghij ", false)).toBe("pk_test_51Abcdefghij");
    expect(() => checkPublishableKey("", false)).toThrow(/publishable key/);
    expect(() => checkPublishableKey("pk_live_51Abcdefghij", false)).toThrow(/same mode/);
    expect(() => checkPublishableKey("sk_test_51Abcdefghij", false)).toThrow(/pk_/);
    expect(() => checkPublishableKey("nonsense", true)).toThrow(/pk_live_/);
  });

  it("must belong to the same account; the check's SetupIntent is always cancelled", async () => {
    const f = fakeStripe({ "setupIntents.create": () => ({ id: "seti_check", client_secret: "seti_check_secret_x" }), "setupIntents.cancel": () => ({}) });
    const read = vi.fn(async () => true);
    await verifyPublishableKeyMatches(f.client, "pk_test_same", read);
    expect(read).toHaveBeenCalledWith("pk_test_same", "seti_check", "seti_check_secret_x");
    expect(f.methods()).toEqual(["setupIntents.create", "setupIntents.cancel"]);

    const g = fakeStripe({ "setupIntents.create": () => ({ id: "seti_2", client_secret: "s" }), "setupIntents.cancel": () => ({}) });
    await expect(verifyPublishableKeyMatches(g.client, "pk_test_other", async () => false)).rejects.toMatchObject({ code: "publishable_mismatch" });
    expect(g.methods()).toContain("setupIntents.cancel");
  });
});
