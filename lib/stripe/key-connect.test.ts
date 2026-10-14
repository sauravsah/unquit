import { randomBytes } from "node:crypto";
import Stripe from "stripe";
import { describe, expect, it, vi } from "vitest";
import { connectWithRestrictedKey, directWebhookUrl, disconnectRestrictedKey, type KeyConnectDeps, type KeyConnectRepo } from "./key-connect";
import { decryptSecret, parseEncryptionKey } from "./key-crypto";
import { KEY_MODE_WEBHOOK_EVENTS, REQUIRED_PERMISSIONS } from "./restricted-key";
import { fakeStripe, stripeErrors, type FakeHandlers } from "./testing/fake-stripe";

const ENC = randomBytes(32).toString("base64");
const RK = "rk_test_51FounderAbcdefghijklmnopqrstuvwxyz0123456789LAST";
const PK = "pk_test_51FounderPublishable123";
const ACCOUNT = "4f6c1d2e-1111-4a4a-8b8b-123456789abc";

/** A founder's Stripe account that grants every permission. */
function founderStripe(extra: FakeHandlers = {}) {
  const h: FakeHandlers = {
    "accounts.retrieveCurrent": () => ({ id: "acct_founder" }),
    "setupIntents.create": () => ({ id: "seti_check", client_secret: "seti_check_secret" }),
    "setupIntents.cancel": () => ({}),
    "webhookEndpoints.create": () => ({ id: "we_new", secret: "whsec_new_secret" }),
    "webhookEndpoints.del": () => ({ deleted: true }),
    ...extra,
  };
  for (const p of REQUIRED_PERMISSIONS) {
    const probeMethod = {
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
    }[p.id];
    h[probeMethod] ??= () => {
      if (probeMethod.endsWith(".list")) return { data: [] };
      throw stripeErrors.missing();
    };
  }
  return fakeStripe(h, "founder");
}

type Row = Parameters<KeyConnectRepo["save"]>[1] & { cleared?: string };

function fakeRepo(opts: { elsewhere?: boolean; saveFails?: unknown; previous?: Awaited<ReturnType<KeyConnectRepo["loadSecrets"]>> } = {}) {
  const rows = new Map<string, Row>();
  const repo: KeyConnectRepo = {
    connectedElsewhere: async () => !!opts.elsewhere,
    loadSecrets: async (id) => {
      const r = rows.get(id);
      if (r && !r.cleared) return { stripe_connection_mode: "key", stripe_key_ciphertext: r.keyCiphertext, stripe_webhook_endpoint_id: r.webhookEndpointId };
      return opts.previous ?? null;
    },
    save: async (id, c) => {
      if (opts.saveFails) throw opts.saveFails;
      rows.set(id, { ...c });
    },
    clear: async (id, at) => {
      const r = rows.get(id);
      rows.set(id, { ...(r as Row), keyCiphertext: "", webhookSecretCiphertext: "", publishableKey: "", cleared: at });
    },
  };
  return { repo, rows };
}

function deps(stripe: ReturnType<typeof founderStripe>, repo: KeyConnectRepo, over: Partial<KeyConnectDeps> = {}): KeyConnectDeps & { clientForKey: ReturnType<typeof vi.fn> } {
  return {
    repo,
    clientForKey: vi.fn(() => stripe.client),
    encryptionKey: () => ENC,
    appUrl: "https://unquit.vercel.app/",
    readWithPublishable: async () => true,
    now: () => new Date("2026-10-14T07:00:00Z"),
    ...over,
  } as never;
}

describe("connectWithRestrictedKey", () => {
  it("validates, creates the per-account webhook, and stores key + signing secret encrypted", async () => {
    const stripe = founderStripe();
    const { repo, rows } = fakeRepo();
    const d = deps(stripe, repo);
    await expect(connectWithRestrictedKey(d, { accountId: ACCOUNT, restrictedKey: ` ${RK} `, publishableKey: PK })).resolves.toEqual({
      stripeAccountId: "acct_founder",
      livemode: false,
      keyLast4: "LAST",
    });
    expect(d.clientForKey).toHaveBeenCalledWith(RK);

    const [create] = stripe.calls.filter((c) => c.method === "webhookEndpoints.create");
    expect(create!.args[0]).toMatchObject({
      url: `https://unquit.vercel.app/api/stripe/webhook/acct/${ACCOUNT}`,
      enabled_events: [...KEY_MODE_WEBHOOK_EVENTS],
      api_version: Stripe.API_VERSION,
      metadata: { created_by: "unquit", unquit_account: ACCOUNT },
    });

    const row = rows.get(ACCOUNT)!;
    expect(row).toMatchObject({ stripeAccountId: "acct_founder", livemode: false, keyLast4: "LAST", publishableKey: PK, webhookEndpointId: "we_new" });
    // Never stored in plain text; only this account's row can decrypt them.
    expect(JSON.stringify(row)).not.toContain(RK);
    expect(JSON.stringify(row)).not.toContain("whsec_new_secret");
    const key = parseEncryptionKey(ENC);
    expect(decryptSecret(row.keyCiphertext, key, ACCOUNT)).toBe(RK);
    expect(decryptSecret(row.webhookSecretCiphertext, key, ACCOUNT)).toBe("whsec_new_secret");
    expect(() => decryptSecret(row.keyCiphertext, key, "another-account")).toThrow();
  });

  it("fails closed without STRIPE_KEY_ENCRYPTION_KEY, before calling Stripe", async () => {
    const stripe = founderStripe();
    const { repo, rows } = fakeRepo();
    await expect(
      connectWithRestrictedKey(deps(stripe, repo, { encryptionKey: () => undefined }), { accountId: ACCOUNT, restrictedKey: RK, publishableKey: PK }),
    ).rejects.toMatchObject({ code: "not_configured" });
    expect(stripe.calls).toHaveLength(0);
    expect(rows.size).toBe(0);
  });

  it("rejects an sk_ key without calling Stripe", async () => {
    const stripe = founderStripe();
    const { repo } = fakeRepo();
    await expect(connectWithRestrictedKey(deps(stripe, repo), { accountId: ACCOUNT, restrictedKey: "sk_test_51Abcdefghijklmnop", publishableKey: PK })).rejects.toMatchObject({
      code: "secret_key",
    });
    expect(stripe.calls).toHaveLength(0);
  });

  it("names a missing permission and creates nothing", async () => {
    const stripe = founderStripe({ "coupons.update": () => { throw stripeErrors.permission("coupon_write"); } });
    const { repo, rows } = fakeRepo();
    const err = await connectWithRestrictedKey(deps(stripe, repo), { accountId: ACCOUNT, restrictedKey: RK, publishableKey: PK }).catch((e) => e);
    expect(err.code).toBe("missing_permissions");
    expect(err.message).toContain("Coupons: Write");
    expect(stripe.methods()).not.toContain("webhookEndpoints.create");
    expect(rows.size).toBe(0);
  });

  it("refuses a publishable key from another account or the other mode", async () => {
    const stripe = founderStripe();
    const { repo } = fakeRepo();
    await expect(
      connectWithRestrictedKey(deps(stripe, repo, { readWithPublishable: async () => false }), { accountId: ACCOUNT, restrictedKey: RK, publishableKey: PK }),
    ).rejects.toMatchObject({ code: "publishable_mismatch" });
    await expect(connectWithRestrictedKey(deps(stripe, repo), { accountId: ACCOUNT, restrictedKey: RK, publishableKey: "pk_live_51Abcdefghijk" })).rejects.toMatchObject({
      code: "publishable_mismatch",
    });
    expect(stripe.methods()).not.toContain("webhookEndpoints.create");
  });

  it("won't connect a Stripe account that another Unquit login already uses", async () => {
    const stripe = founderStripe();
    const { repo } = fakeRepo({ elsewhere: true });
    await expect(connectWithRestrictedKey(deps(stripe, repo), { accountId: ACCOUNT, restrictedKey: RK, publishableKey: PK })).rejects.toMatchObject({
      code: "already_connected_elsewhere",
    });
    expect(stripe.methods()).not.toContain("webhookEndpoints.create");
  });

  it("deletes the new endpoint again if saving fails (unique race included)", async () => {
    const stripe = founderStripe();
    const { repo } = fakeRepo({ saveFails: Object.assign(new Error("dup"), { code: "23505" }) });
    await expect(connectWithRestrictedKey(deps(stripe, repo), { accountId: ACCOUNT, restrictedKey: RK, publishableKey: PK })).rejects.toMatchObject({
      code: "already_connected_elsewhere",
    });
    expect(stripe.calls.find((c) => c.method === "webhookEndpoints.del")?.args[0]).toBe("we_new");
  });

  it("reconnecting (key rotation) deletes the previous endpoint first", async () => {
    const stripe = founderStripe();
    const { repo } = fakeRepo();
    await connectWithRestrictedKey(deps(stripe, repo), { accountId: ACCOUNT, restrictedKey: RK, publishableKey: PK });
    await connectWithRestrictedKey(deps(stripe, repo), { accountId: ACCOUNT, restrictedKey: RK, publishableKey: PK });
    expect(stripe.calls.filter((c) => c.method === "webhookEndpoints.del").map((c) => c.args[0])).toEqual(["we_new"]);
  });

  it("builds the per-account webhook URL", () => {
    expect(directWebhookUrl("https://x.dev//", "abc")).toBe("https://x.dev/api/stripe/webhook/acct/abc");
  });
});

describe("disconnectRestrictedKey", () => {
  async function connected() {
    const stripe = founderStripe();
    const { repo, rows } = fakeRepo();
    const d = deps(stripe, repo);
    await connectWithRestrictedKey(d, { accountId: ACCOUNT, restrictedKey: RK, publishableKey: PK });
    return { stripe, rows, d };
  }

  it("deletes the webhook endpoint with the founder's decrypted key, then wipes every secret", async () => {
    const { stripe, rows, d } = await connected();
    d.clientForKey.mockClear();
    await expect(disconnectRestrictedKey(d, ACCOUNT)).resolves.toEqual({ webhookDeleted: true });
    expect(d.clientForKey).toHaveBeenCalledWith(RK);
    expect(stripe.calls.filter((c) => c.method === "webhookEndpoints.del").map((c) => c.args[0])).toEqual(["we_new"]);
    const row = rows.get(ACCOUNT)!;
    expect(row.cleared).toBeTruthy();
    expect(row.keyCiphertext).toBe("");
    expect(row.webhookSecretCiphertext).toBe("");
  });

  it("still wipes the secrets when the key was already revoked in Stripe", async () => {
    const { stripe, rows, d } = await connected();
    const revoked = fakeStripe({ "webhookEndpoints.del": () => { throw stripeErrors.auth(); } });
    d.clientForKey.mockImplementation(() => revoked.client);
    await expect(disconnectRestrictedKey(d, ACCOUNT)).resolves.toEqual({ webhookDeleted: false });
    expect(rows.get(ACCOUNT)!.cleared).toBeTruthy();
    expect(stripe.methods()).not.toContain("webhookEndpoints.del");
  });

  it("treats an endpoint that is already gone as deleted, and works without the encryption key", async () => {
    const { rows, d } = await connected();
    const gone = fakeStripe({ "webhookEndpoints.del": () => { throw stripeErrors.missing(); } });
    d.clientForKey.mockImplementation(() => gone.client);
    await expect(disconnectRestrictedKey(d, ACCOUNT)).resolves.toEqual({ webhookDeleted: true });

    const again = await connected();
    await expect(disconnectRestrictedKey({ ...again.d, encryptionKey: () => undefined }, ACCOUNT)).resolves.toEqual({ webhookDeleted: false });
    expect(again.rows.get(ACCOUNT)!.cleared).toBeTruthy();
    expect(rows.get(ACCOUNT)!.cleared).toBeTruthy();
  });
});
