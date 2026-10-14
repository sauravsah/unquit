/**
 * POST /api/billing/dodo/webhook: Standard Webhooks verification, then the
 * webhook-id log, against PGlite. A replayed delivery changes nothing.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { addFounder, createTestDb, type TestDb } from "@/lib/db/testing/pglite";

vi.mock("server-only", () => ({}));
const SECRET = `whsec_${Buffer.from("route-test-signing-key-32-bytes!").toString("base64")}`;
const env = {
  DODO_PAYMENTS_WEBHOOK_SECRET: SECRET,
  DODO_PAYMENTS_API_KEY: "test_key_unused",
  DODO_PAYMENTS_ENVIRONMENT: "test_mode",
  DODO_USAGE_PRODUCT_ID: "pdt_usage",
  NEXT_PUBLIC_APP_URL: "https://app.unquit.test",
};
const saved: Record<string, string | undefined> = {};
for (const [k, v] of Object.entries(env)) {
  saved[k] = process.env[k];
  process.env[k] = v;
}
const { setDbForTesting } = await import("@/lib/db");
const { POST } = await import("@/app/api/billing/dodo/webhook/route");
const { sign } = await import("./webhook-verify");

let db: TestDb;
let paymentId = "";
let chargeId = "";

beforeAll(async () => {
  db = await createTestDb();
  setDbForTesting(db);
  const { accountId } = await addFounder(db, { stripe: "acct_route" });
  const periodId = await db.value<string>(
    `insert into billing_periods (account_id, period_month, status, gross_cents, capped_cents, total_cents, amount_due_cents, payment_status)
     values ($1, '2026-09-01', 'closed', 2000, 2000, 2000, 2000, 'processing') returning id`,
    [accountId],
  );
  chargeId = await db.value<string>(
    `insert into billing_charges (account_id, billing_period_id, amount_cents, status, attempts_count, cycle_attempts, cycle_started_at, dodo_payment_id)
     values ($1, $2, 2000, 'processing', 1, 1, now(), 'pay_route') returning id`,
    [accountId, periodId],
  );
  await db.query(`insert into billing_charge_attempts (charge_id, attempt_no, amount_cents, state, dodo_payment_id) values ($1, 1, 2000, 'processing', 'pay_route')`, [chargeId]);
  paymentId = "pay_route";
}, 60_000);

afterAll(() => {
  setDbForTesting(null);
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

function request(body: string, opts: { id?: string; timestamp?: number; secret?: string; signature?: string } = {}) {
  const id = opts.id ?? "msg_route_1";
  const ts = String(opts.timestamp ?? Math.floor(Date.now() / 1000));
  const signature = opts.signature ?? `v1,${sign(opts.secret ?? SECRET, id, ts, body)}`;
  return new Request("https://app.unquit.test/api/billing/dodo/webhook", {
    method: "POST",
    headers: { "content-type": "application/json", "webhook-id": id, "webhook-timestamp": ts, "webhook-signature": signature },
    body,
  });
}

const body = () =>
  JSON.stringify({
    business_id: "bus_test",
    type: "payment.succeeded",
    timestamp: new Date().toISOString(),
    data: { payload_type: "Payment", payment_id: paymentId, status: "succeeded", invoice_url: "https://test.dodopayments.com/invoices/payments/pay_route", metadata: {} },
  });

describe("Dodo webhook route", () => {
  it("rejects unsigned, mis-signed and stale deliveries without touching the database", async () => {
    const b = body();
    expect((await POST(request(b, { signature: "v1,AAAA" }))).status).toBe(401);
    expect((await POST(request(b, { secret: `whsec_${Buffer.from("some-other-32-byte-signing-key!!").toString("base64")}` }))).status).toBe(401);
    expect((await POST(request(b, { timestamp: Math.floor(Date.now() / 1000) - 600 }))).status).toBe(401);
    const missing = new Request("https://app.unquit.test/api/billing/dodo/webhook", { method: "POST", body: b });
    expect((await POST(missing)).status).toBe(401);
    expect(await db.count("dodo_webhook_events")).toBe(0);
    expect(await db.value("select status from billing_charges where id = $1", [chargeId])).toBe("processing");
  });

  it("processes a signed delivery once and acknowledges the replay as a duplicate", async () => {
    const b = body();
    const first = await POST(request(b));
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ received: true, outcome: "processed" });
    expect(await db.query("select status, receipt_url from billing_charges where id = $1", [chargeId])).toEqual([
      { status: "paid", receipt_url: "https://test.dodopayments.com/invoices/payments/pay_route" },
    ]);

    const replay = await POST(request(b));
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual({ received: true, duplicate: true });
    expect(await db.count("dodo_webhook_events")).toBe(1);
    expect(await db.count("billing_charge_attempts", "state = 'succeeded'")).toBe(1);
  });
});
