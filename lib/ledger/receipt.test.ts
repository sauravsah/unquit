import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
import { isAdminEmail, parseEmailList } from "@/lib/env";
import { saveRate } from "@/lib/dashboard";
import { filtersToQuery, parseLedgerFilters } from "./dashboard";
import { buildTimeline, feeLineViews, stripeDashboardUrl, verifyingInvoiceIds, type ReceiptData } from "./receipt";
import { fakeLedger } from "./testing/fakes";
import type { SaveEventRow } from "./types";

function receipt(over: Partial<ReceiptData> = {}): ReceiptData {
  const db = fakeLedger();
  const save = db.addSave({
    status: "verified",
    created_at: "2026-08-10T12:00:00.000Z",
    verified_at: "2026-09-01T00:05:00.000Z",
    stripe_invoice_id: "in_1",
    saved_mrr_cents: 7_000,
  });
  const m1 = db.addLine({ save_id: save.id, month_index: 1, stripe_invoice_id: "in_1", amount_cents: 1_400, invoice_amount_paid_cents: 7_000, billing_month: "2026-09-01" });
  const ev = (kind: SaveEventRow["kind"], at: string, detail: Record<string, unknown> = {}): SaveEventRow => ({ id: kind + at, save_id: save.id, kind, detail, occurred_at: at });
  return {
    save,
    session: { reason: "too_expensive", reason_label: "Too expensive", reason_detail: null, offer_accepted_at: "2026-08-10T12:00:00.000Z", started_at: "2026-08-10T11:58:00.000Z" },
    dunningCase: null,
    lines: [m1],
    clawbacks: [],
    events: [ev("invoice_paid", "2026-09-01T00:05:00.000Z", { amount_paid_cents: 7_000 }), ev("verified", "2026-09-01T00:05:00.000Z")],
    disputes: [],
    periods: [],
    stripeLivemode: false,
    ...over,
  };
}

describe("receipt timeline", () => {
  it("shows offer accepted → invoice paid → verified for a cancel save", () => {
    const items = buildTimeline(receipt());
    expect(items.map((i) => i.title)).toEqual(["Offer accepted", "Invoice paid", "Verified"]);
    expect(items[0]!.detail).toBe("30% off × 3 mo · reason: Too expensive");
    expect(items[1]!.detail).toBe("in_1 · $70.00");
    expect(items[2]!.detail).toBe("Month 1 fee: $14.00");
    expect(items.every((i) => i.tone === "done")).toBe(true);
  });

  it("adds later lines in time order: months, refunds, disputes, billing, and 'free from now on'", () => {
    const base = receipt();
    const id = base.save.id;
    const m2 = { ...base.lines[0]!, id: "l2", month_index: 2, stripe_invoice_id: "in_2", billing_month: "2026-10-01" };
    const m3 = { ...base.lines[0]!, id: "l3", month_index: 3, stripe_invoice_id: "in_3", billing_month: "2026-11-01" };
    const billed = { ...base.lines[0]!, billing_period_id: "p_sep", billed_at: "2026-10-01T06:00:00.000Z" };
    const data = receipt({
      lines: [billed, m2, m3],
      periods: [{ id: "p_sep", period_month: "2026-09-01", status: "invoiced", hosted_invoice_url: "https://invoice.stripe.test/x" }],
      events: [
        ...base.events,
        { id: "e3", save_id: id, kind: "refund", detail: { clawed_back_cents: 350, month_index: 1 }, occurred_at: "2026-09-20T00:00:00.000Z" },
        { id: "e4", save_id: id, kind: "fee_line", detail: { month_index: 2, invoice: "in_2", fee_cents: 1_400 }, occurred_at: "2026-10-01T00:00:00.000Z" },
        { id: "e5", save_id: id, kind: "dispute_opened", detail: { category: "would_have_stayed" }, occurred_at: "2026-10-03T00:00:00.000Z" },
        { id: "e6", save_id: id, kind: "dispute_rejected", detail: { note: "They paid again" }, occurred_at: "2026-10-04T00:00:00.000Z" },
      ],
    });
    const titles = buildTimeline(data).map((i) => i.title);
    expect(titles).toEqual([
      "Offer accepted",
      "Invoice paid",
      "Verified",
      "Customer refunded",
      "Month 2 paid",
      "Billed on the September 2026 statement",
      "You disputed this save",
      "Dispute reviewed: fee stands",
      "Free from now on",
    ]);
  });

  it("shows a pending save waiting for its invoice, with the expiry date", () => {
    const base = receipt();
    const data = receipt({ save: { ...base.save, status: "pending", verified_at: null, stripe_invoice_id: null }, lines: [], events: [] });
    const items = buildTimeline(data);
    expect(items.map((i) => i.title)).toEqual(["Offer accepted", "Waiting for the next paid invoice"]);
    expect(items[1]!.detail).toContain("Sep 24, 2026"); // 45 days after Aug 10
    expect(items[1]!.tone).toBe("pending");
  });

  it("explains a lost save", () => {
    const base = receipt();
    const data = receipt({
      save: { ...base.save, status: "lost", verified_at: null, lost_reason: "superseded", lost_at: "2026-08-15T00:00:00Z" },
      lines: [],
      events: [{ id: "l", save_id: base.save.id, kind: "lost", detail: { reason: "superseded" }, occurred_at: "2026-08-15T00:00:00.000Z" }],
    });
    const items = buildTimeline(data);
    expect(items.map((i) => i.title)).toEqual(["Offer accepted", "Lost"]);
    expect(items[1]!.detail).toMatch(/newer cancel session/);
  });

  it("shows how a dunning save was won", () => {
    const base = receipt();
    const data = receipt({
      save: { ...base.save, type: "dunning", attributed_via: "update_link", recovered_amount_cents: 4_900, fee_cents: 490 },
      lines: [{ ...base.lines[0]!, amount_cents: 490 }],
      session: null,
      dunningCase: {
        stripe_invoice_id: "in_1",
        customer_email: "jamie@example.com",
        customer_name: null,
        invoice_number: null,
        decline_code: "expired_card",
        decline_category: "hard",
        opened_at: "2026-08-28T00:00:00.000Z",
        recovered_at: "2026-08-30T00:00:00.000Z",
        recovered_via: "update_link",
      },
      events: [],
    });
    const items = buildTimeline(data);
    expect(items.map((i) => i.title)).toEqual(["Payment failed", "Invoice paid", "Verified"]);
    expect(items[1]!.detail).toContain("updated their card");
    expect(items[2]!.detail).toBe("Fee: $4.90 (10%)");
  });

  it("keeps lifecycle order when a test clock stamps the invoice after the refund", () => {
    const base = receipt();
    const id = base.save.id;
    const data = receipt({
      save: { ...base.save, status: "clawed_back", verified_at: "2026-11-13T10:00:00.000Z" },
      lines: [{ ...base.lines[0]!, amount_cents: 490, clawed_back_cents: 490 }],
      events: [
        { id: "p", save_id: id, kind: "invoice_paid", detail: { amount_paid_cents: 2_450 }, occurred_at: "2026-11-13T10:00:00.000Z" },
        { id: "r", save_id: id, kind: "refund", detail: { clawed_back_cents: 490, month_index: 1 }, occurred_at: "2026-10-13T10:05:00.000Z" },
      ],
    });
    const items = buildTimeline(data);
    expect(items.map((i) => i.title)).toEqual(["Offer accepted", "Invoice paid", "Verified", "Customer refunded"]);
    expect(items[3]!.detail).toBe("Month 1 fee clawed back ($4.90)");
  });

  it("orders by time otherwise, with outcomes after what they settle", () => {
    const base = receipt();
    const id = base.save.id;
    const data = receipt({
      events: [
        ...base.events,
        { id: "a", save_id: id, kind: "dispute_accepted", detail: { resolution: "admin" }, occurred_at: "2026-09-05T00:00:00.000Z" },
        { id: "o", save_id: id, kind: "dispute_opened", detail: { category: "would_have_stayed" }, occurred_at: "2026-09-06T00:00:00.000Z" },
        { id: "e", save_id: id, kind: "ended", detail: {}, occurred_at: "2026-09-04T00:00:00.000Z" },
      ],
    });
    const titles = buildTimeline(data).map((i) => i.title);
    expect(titles).toEqual(["Offer accepted", "Invoice paid", "Verified", "Subscription cancelled", "You disputed this save", "Dispute accepted: fee reversed"]);
  });

  it("words clawbacks and chargeback outcomes precisely", () => {
    const base = receipt();
    const id = base.save.id;
    const ev = (kind: SaveEventRow["kind"], at: string, detail: Record<string, unknown>): SaveEventRow => ({ id: kind + at, save_id: id, kind, detail, occurred_at: at });
    const data = receipt({
      events: [
        ...base.events,
        ev("credit_note", "2026-09-10T00:00:00.000Z", { clawed_back_cents: 350, month_index: 1 }),
        ev("stripe_dispute_opened", "2026-09-11T00:00:00.000Z", {}),
        ev("stripe_dispute_won", "2026-09-12T00:00:00.000Z", { status: "won" }),
        ev("stripe_dispute_opened", "2026-09-13T00:00:00.000Z", {}),
        ev("stripe_dispute_won", "2026-09-14T00:00:00.000Z", { status: "warning_closed" }),
        ev("stripe_dispute_lost", "2026-09-15T00:00:00.000Z", { clawed_back_cents: 1_050, month_index: 1 }),
        ev("dispute_accepted", "2026-09-16T00:00:00.000Z", { resolution: "auto" }),
      ],
    });
    const items = buildTimeline(data).slice(3);
    expect(items.map((i) => i.title)).toEqual([
      "Credit note issued",
      "Chargeback opened",
      "Chargeback won",
      "Chargeback opened",
      "Chargeback closed",
      "Chargeback lost: fee reversed",
      "Dispute accepted automatically: fee reversed",
    ]);
    expect(items[0]!.detail).toBe("Month 1 fee partly clawed back ($3.50 of $14.00)");
    expect(items[5]!.detail).toBe("Month 1 fee partly reversed ($10.50 of $14.00)");
  });

  it("lists verifying invoices, fee lines with holds and statements, and test-mode Stripe links", () => {
    const base = receipt();
    const data = receipt({
      lines: [{ ...base.lines[0]!, clawed_back_cents: 400, held_stripe_dispute_id: "dp_1", billing_period_id: "p", billed_at: "2026-10-01T00:00:00Z" }],
      periods: [{ id: "p", period_month: "2026-09-01", status: "invoiced", hosted_invoice_url: null }],
    });
    expect(verifyingInvoiceIds(data)).toEqual(["in_1"]);
    expect(feeLineViews(data)[0]).toMatchObject({ netCents: 1_000, held: true, holdReason: "Chargeback open", statement: { slug: "2026-09" } });
    expect(stripeDashboardUrl("invoices", "in_1", false)).toBe("https://dashboard.stripe.com/test/invoices/in_1");
    expect(stripeDashboardUrl("invoices", "in_1", true)).toBe("https://dashboard.stripe.com/invoices/in_1");
  });
});

describe("dashboard helpers", () => {
  it("parses ledger filters and ignores junk", () => {
    expect(parseLedgerFilters({ type: "cancel", status: "lost", month: "2026-09" })).toEqual({ type: "cancel", status: "lost", month: "2026-09" });
    expect(parseLedgerFilters({ type: "x", status: "y", month: "2026-13" })).toEqual({ type: null, status: null, month: null });
    expect(parseLedgerFilters(new URLSearchParams("type=dunning"))).toEqual({ type: "dunning", status: null, month: null });
    expect(filtersToQuery({ type: "dunning", status: null, month: "2026-09" })).toBe("?type=dunning&month=2026-09");
    expect(filtersToQuery({ type: null, status: null, month: null })).toBe("");
  });

  it("computes the save rate from finished cancel attempts", () => {
    expect(saveRate(0, 0)).toBeNull();
    expect(saveRate(10, 3)).toBe(0.3);
    expect(saveRate(2, 5)).toBe(1);
  });

  it("reads ADMIN_EMAILS case-insensitively", () => {
    const admins = parseEmailList(" Saurav@Example.com, ops@unquit.app;nope ");
    expect(admins).toEqual(["saurav@example.com", "ops@unquit.app"]);
    expect(isAdminEmail("SAURAV@example.com", admins)).toBe(true);
    expect(isAdminEmail("someone@example.com", admins)).toBe(false);
    expect(isAdminEmail(null, admins)).toBe(false);
    expect(isAdminEmail("a@b.c", [])).toBe(false);
  });
});
