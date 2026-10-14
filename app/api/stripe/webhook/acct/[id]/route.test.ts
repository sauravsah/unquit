/** The per-account webhook of a restricted-key connection: its own encrypted signing secret, its own account. */
import { randomBytes } from "node:crypto";
import Stripe from "stripe";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sealForAccount } from "@/lib/stripe/connection";

const ACCOUNT = "4f6c1d2e-1111-4a4a-8b8b-123456789abc";
const ENC = randomBytes(32).toString("base64");
const SECRET = "whsec_per_account_secret";

const state = vi.hoisted(() => ({
  account: null as null | { id: string; stripe_account_id: string; stripe_webhook_secret_ciphertext: string },
  handled: [] as { event: { id: string }; deps: Record<string, unknown> }[],
  claimed: [] as unknown[],
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({ getDb: () => ({}) }));
vi.mock("@/lib/accounts", () => ({ loadDirectWebhookAccount: async (_db: unknown, id: string) => (state.account?.id === id ? state.account : null) }));
vi.mock("@/lib/stripe/webhook-events", () => ({
  claimWebhookEvent: async (_db: unknown, event: unknown, opts: unknown) => {
    state.claimed.push({ event, opts });
    return "claimed";
  },
  finishWebhookEvent: async () => undefined,
}));
vi.mock("@/lib/stripe/webhook-handlers", () => ({
  handleStripeEvent: async (_db: unknown, event: { id: string }, deps: Record<string, unknown>) => {
    state.handled.push({ event, deps });
    return "processed";
  },
}));
vi.mock("@/lib/dunning/service", () => ({ runDunningForCase: async () => undefined }));
vi.mock("@/lib/dunning/runtime", () => ({ sequenceDeps: () => ({}) }));
vi.mock("@/lib/ledger/disputes", () => ({ sendReceiptEmails: async () => undefined }));
vi.mock("@/lib/ledger/runtime", () => ({ ledgerDeps: () => ({}) }));

const { POST } = await import("./route");

const signer = new Stripe("sk_test_signer");
function signed(payload: string, secret = SECRET) {
  return new Request(`https://unquit.test/api/stripe/webhook/acct/${ACCOUNT}`, {
    method: "POST",
    headers: { "stripe-signature": signer.webhooks.generateTestHeaderString({ payload, secret }) },
    body: payload,
  });
}
const payload = JSON.stringify({ id: "evt_direct", object: "event", type: "invoice.paid", data: { object: { id: "in_1" } } });

beforeEach(() => {
  process.env.STRIPE_KEY_ENCRYPTION_KEY = ENC;
  state.account = { id: ACCOUNT, stripe_account_id: "acct_founder", stripe_webhook_secret_ciphertext: sealForAccount(SECRET, ACCOUNT, ENC) };
  state.handled = [];
  state.claimed = [];
});
afterEach(() => {
  delete process.env.STRIPE_KEY_ENCRYPTION_KEY;
});

describe("POST /api/stripe/webhook/acct/[id]", () => {
  it("verifies with THIS account's secret and handles the event as that account's", async () => {
    const res = await POST(signed(payload), { params: { id: ACCOUNT } });
    expect(res.status).toBe(200);
    expect(state.handled).toHaveLength(1);
    expect(state.handled[0]!.deps.directStripeAccountId).toBe("acct_founder");
    expect(state.claimed[0]).toMatchObject({ opts: { stripeAccountId: "acct_founder" } });
  });

  it("rejects a signature made with any other secret (e.g. the Connect webhook's)", async () => {
    const res = await POST(signed(payload, "whsec_someone_else"), { params: { id: ACCOUNT } });
    expect(res.status).toBe(400);
    expect(state.handled).toHaveLength(0);
  });

  it("404s for unknown or disconnected accounts and malformed ids", async () => {
    state.account = null;
    expect((await POST(signed(payload), { params: { id: ACCOUNT } })).status).toBe(404);
    expect((await POST(signed(payload), { params: { id: "../etc" } })).status).toBe(404);
    expect(state.handled).toHaveLength(0);
  });

  it("fails closed (500, Stripe retries) without the encryption key", async () => {
    delete process.env.STRIPE_KEY_ENCRYPTION_KEY;
    expect((await POST(signed(payload), { params: { id: ACCOUNT } })).status).toBe(500);
    expect(state.handled).toHaveLength(0);
  });
});
