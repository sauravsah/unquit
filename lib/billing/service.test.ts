import { describe, expect, it } from "vitest";
import { applyInvoiceReversal } from "@/lib/ledger/clawbacks";
import { fakeBillingStripe, fakeLedger } from "@/lib/ledger/testing/fakes";
import { billAccountForMonth, invoiceItemsFor, monthToBill, runMonthlyBilling, type BillingDeps } from "./service";
import { buildStatement, creditOwedCents } from "./statement";

const OCT_1 = new Date("2026-10-01T06:00:00Z");

function setup(now = OCT_1) {
  let clock = now;
  const db = fakeLedger({ clock: () => clock });
  db.addAccount();
  const stripe = fakeBillingStripe();
  const logs: string[] = [];
  const deps: BillingDeps = { repo: db.billing, stripe: stripe.stripe, appUrl: "https://app.unquit.test", now: () => clock, log: (l) => logs.push(l) };
  const cancelSave = () => db.addSave({ status: "verified", verified_at: "2026-09-02T00:00:00Z" });
  const dunningSave = () =>
    db.addSave({ type: "dunning", cancel_session_id: null, dunning_case_id: `case_${Math.random()}`, status: "verified", verified_at: "2026-09-03T00:00:00Z" });
  return {
    db,
    stripe,
    deps,
    logs,
    cancelSave,
    dunningSave,
    at(d: Date) {
      clock = d;
    },
  };
}

describe("statement maths", () => {
  it("sums verified, unheld lines net of clawbacks, split by type, then applies the $299 cap", () => {
    const s = buildStatement([
      { id: "1", saveId: "a", kind: "cancel", amountCents: 20_000, clawedBackCents: 0 },
      { id: "2", saveId: "b", kind: "cancel", amountCents: 15_000, clawedBackCents: 5_000 },
      { id: "3", saveId: "c", kind: "dunning", amountCents: 2_000, clawedBackCents: 0 },
      { id: "4", saveId: "d", kind: "dunning", amountCents: 900, clawedBackCents: 900 },
    ]);
    expect(s).toMatchObject({
      cancelFeesCents: 30_000,
      cancelLinesCount: 2,
      dunningFeesCents: 2_000,
      dunningLinesCount: 1,
      clawedBackCents: 5_900,
      grossCents: 32_000,
      capDiscountCents: 2_100,
      cappedCents: 29_900,
      totalCents: 29_900,
      capReached: true,
    });
  });

  it("credits refunds on earlier statements, re-applying the cap (never refunding a waived fee)", () => {
    // September was $400 gross, capped at $299. A $50 refund later still leaves $350 > $299: no credit.
    const sept = { id: "p", cappedCents: 29_900, capCents: 29_900, creditAppliedCents: 0, lines: [{ id: "x", saveId: "s", kind: "cancel" as const, amountCents: 40_000, clawedBackCents: 5_000 }] };
    expect(creditOwedCents([sept])).toBe(0);
    // A $150 refund drops it to $250: $49 comes back.
    expect(creditOwedCents([{ ...sept, lines: [{ ...sept.lines[0]!, clawedBackCents: 15_000 }] }])).toBe(4_900);
    // Already credited elsewhere: nothing more.
    expect(creditOwedCents([{ ...sept, creditAppliedCents: 4_900, lines: [{ ...sept.lines[0]!, clawedBackCents: 15_000 }] }])).toBe(0);
  });

  it("knows which month to bill", () => {
    expect(monthToBill(OCT_1)).toBe("2026-09-01");
    expect(monthToBill(new Date("2026-01-01T00:00:00Z"))).toBe("2025-12-01");
  });
});

describe("monthly billing", () => {
  it("creates and finalizes one Stripe invoice summarising cancel saves and dunning recoveries", async () => {
    const { db, stripe, deps, cancelSave, dunningSave } = setup();
    const a = cancelSave();
    const b = cancelSave();
    const d = dunningSave();
    db.addLine({ save_id: a.id, billing_month: "2026-09-01", amount_cents: 2_000 });
    db.addLine({ save_id: b.id, billing_month: "2026-08-01", amount_cents: 1_400, month_index: 2 }); // late-arriving earlier month
    db.addLine({ save_id: d.id, billing_month: "2026-09-01", amount_cents: 490 });
    db.addLine({ save_id: a.id, billing_month: "2026-10-01", amount_cents: 2_000, month_index: 2 }); // this month: not yet

    const out = await billAccountForMonth(deps, "acc_1", "2026-09-01");
    expect(out).toMatchObject({ outcome: "invoiced", totalCents: 3_890 });
    expect(stripe.customers).toEqual([{ id: "cus_platform_1", accountId: "acc_1", email: "founder@acme.test" }]);
    const [invoice] = stripe.live();
    expect(invoice).toMatchObject({ status: "open", totalCents: 3_890, collection: "send_invoice", customerId: "cus_platform_1" });
    expect(invoice!.items.map((i) => [i.key, i.amountCents])).toEqual([
      ["cancel", 3_400],
      ["dunning", 490],
    ]);
    expect(invoice!.items[0]!.description).toBe("Cancel saves, September 2026: 2 paid months × 20% of saved MRR");
    expect(invoice!.footer).toContain("https://app.unquit.test/dashboard/billing/2026-09");
    expect(invoice!.metadata).toMatchObject({ unquit_account_id: "acc_1", unquit_period: "2026-09" });

    const period = db.periods[0]!;
    expect(period).toMatchObject({
      status: "invoiced",
      period_month: "2026-09-01",
      cancel_fees_cents: 3_400,
      dunning_fees_cents: 490,
      total_cents: 3_890,
      stripe_invoice_id: invoice!.id,
      hosted_invoice_url: `https://invoice.stripe.test/${invoice!.id}`,
      invoice_status: "open",
    });
    expect(db.lines.filter((l) => l.billing_period_id === period.id)).toHaveLength(3);
    expect(db.lines.find((l) => l.billing_month === "2026-10-01")!.billing_period_id).toBeNull();
    expect(db.accounts.get("acc_1")!.platform_customer_id).toBe("cus_platform_1");
  });

  it("charges the saved card when the founder added one", async () => {
    const { db, stripe, deps, cancelSave } = setup();
    db.accounts.get("acc_1")!.billing_pm_status = "active";
    db.addLine({ save_id: cancelSave().id, billing_month: "2026-09-01", amount_cents: 2_000 });
    await billAccountForMonth(deps, "acc_1", "2026-09-01");
    expect(stripe.live()[0]!.collection).toBe("charge_automatically");
  });

  it("caps the month at $299 with a visible cap line", async () => {
    const { db, stripe, deps, cancelSave } = setup();
    for (let i = 0; i < 20; i++) db.addLine({ save_id: cancelSave().id, billing_month: "2026-09-01", amount_cents: 2_000 }); // $400
    const out = await billAccountForMonth(deps, "acc_1", "2026-09-01");
    expect(out).toMatchObject({ outcome: "invoiced", totalCents: 29_900 });
    expect(stripe.live()[0]!.items.map((i) => [i.key, i.amountCents])).toEqual([
      ["cancel", 40_000],
      ["cap", -10_100],
    ]);
    expect(db.periods[0]).toMatchObject({ gross_cents: 40_000, cap_discount_cents: 10_100, capped_cents: 29_900, total_cents: 29_900 });
  });

  it("is idempotent per account and month: re-running bills nothing twice", async () => {
    const { db, stripe, deps, cancelSave } = setup();
    db.addLine({ save_id: cancelSave().id, billing_month: "2026-09-01", amount_cents: 2_000 });
    const first = await runMonthlyBilling(deps);
    const second = await runMonthlyBilling(deps);
    expect(first).toMatchObject({ month: "2026-09-01", accounts: 1, invoiced: 1 });
    expect(second).toMatchObject({ month: "2026-09-01", accounts: 1, already_done: 1 });
    expect(stripe.invoices).toHaveLength(1);
    expect(db.periods).toHaveLength(1);
  });

  it("$0 month: no invoice (no Stripe calls at all), but a statement row", async () => {
    const { db, stripe, deps, cancelSave } = setup();
    const s = cancelSave();
    db.addLine({ save_id: s.id, billing_month: "2026-09-01", amount_cents: 2_000, clawed_back_cents: 2_000, status: "clawed_back" });
    expect(await billAccountForMonth(deps, "acc_1", "2026-09-01")).toMatchObject({ outcome: "zero" });
    expect(stripe.invoices).toHaveLength(0);
    expect(stripe.customers).toHaveLength(0);
    expect(db.periods[0]).toMatchObject({ status: "zero", total_cents: 0, stripe_invoice_id: null });
    expect(await billAccountForMonth(deps, "acc_1", "2026-09-01")).toMatchObject({ outcome: "already_done", status: "zero" });
  });

  it("gives every connected founder a statement, even with no saves", async () => {
    const { db, deps } = setup();
    db.addAccount({ id: "acc_new", connected_at: "2026-10-01T01:00:00Z" }); // connected after September: no September statement
    db.addAccount({ id: "acc_gone", connected: false, connected_at: null });
    const summary = await runMonthlyBilling(deps);
    expect(summary).toMatchObject({ accounts: 1, zero: 1 });
    expect(db.periods.map((p) => p.account_id)).toEqual(["acc_1"]);
  });

  it("leaves held lines (open Stripe or founder dispute) for a later statement", async () => {
    const { db, stripe, deps, cancelSave, at } = setup();
    const s = cancelSave();
    db.addLine({ save_id: s.id, billing_month: "2026-09-01", amount_cents: 2_000, held_stripe_dispute_id: "dp_1" });
    db.addLine({ save_id: cancelSave().id, billing_month: "2026-09-01", amount_cents: 1_000, held_founder_dispute_id: "dsp_1" });
    expect(await billAccountForMonth(deps, "acc_1", "2026-09-01")).toMatchObject({ outcome: "zero" });

    // The Stripe dispute is won in October: the line is billed on October's statement.
    await db.repo.releaseStripeHold("acc_1", "dp_1");
    at(new Date("2026-11-01T06:00:00Z"));
    expect(await billAccountForMonth(deps, "acc_1", "2026-10-01")).toMatchObject({ outcome: "invoiced", totalCents: 2_000 });
    expect(stripe.live()).toHaveLength(1);
  });

  it("credits a refund on an already-billed fee on the next statement", async () => {
    const { db, stripe, deps, cancelSave, at } = setup();
    const s = cancelSave();
    db.addLine({ save_id: s.id, stripe_invoice_id: "in_sep", billing_month: "2026-09-01", amount_cents: 2_000, invoice_amount_paid_cents: 10_000 });
    await billAccountForMonth(deps, "acc_1", "2026-09-01");

    // October: the customer is refunded half of September's invoice, and a new save earns $14.
    await applyInvoiceReversal(db.repo, "acc_1", { invoiceId: "in_sep", sourceKey: "charge:ch_1", kind: "refund", amountCents: 5_000 }, new Date("2026-10-10T00:00:00Z"));
    db.addLine({ save_id: cancelSave().id, billing_month: "2026-10-01", amount_cents: 1_400 });
    at(new Date("2026-11-01T06:00:00Z"));
    expect(await billAccountForMonth(deps, "acc_1", "2026-10-01")).toMatchObject({ outcome: "invoiced", totalCents: 400 });
    expect(stripe.live()[1]!.items.map((i) => [i.key, i.amountCents])).toEqual([
      ["cancel", 1_400],
      ["credit", -1_000],
    ]);
    // The credit is given once.
    at(new Date("2026-12-01T06:00:00Z"));
    expect(await billAccountForMonth(deps, "acc_1", "2026-11-01")).toMatchObject({ outcome: "zero" });
  });

  it("carries a credit larger than the month's fees forward", async () => {
    const { db, deps, cancelSave, at } = setup();
    db.addLine({ save_id: cancelSave().id, stripe_invoice_id: "in_sep", billing_month: "2026-09-01", amount_cents: 2_000, invoice_amount_paid_cents: 10_000 });
    await billAccountForMonth(deps, "acc_1", "2026-09-01");
    await applyInvoiceReversal(db.repo, "acc_1", { invoiceId: "in_sep", sourceKey: "charge:ch_1", kind: "refund", amountCents: 10_000 }, new Date("2026-10-10T00:00:00Z"));
    db.addLine({ save_id: cancelSave().id, billing_month: "2026-10-01", amount_cents: 500 });
    at(new Date("2026-11-01T06:00:00Z"));
    expect(await billAccountForMonth(deps, "acc_1", "2026-10-01")).toMatchObject({ outcome: "zero" });
    expect(db.periods[1]).toMatchObject({ capped_cents: 500, credit_applied_cents: 500, total_cents: 0 });
    db.addLine({ save_id: cancelSave().id, billing_month: "2026-11-01", amount_cents: 3_000 });
    at(new Date("2026-12-01T06:00:00Z"));
    expect(await billAccountForMonth(deps, "acc_1", "2026-11-01")).toMatchObject({ outcome: "invoiced", totalCents: 1_500 }); // 3,000 − the remaining 1,500
  });

  it("recovers from a crash half way: the draft is rebuilt and only one invoice is ever finalized", async () => {
    const { db, stripe, deps, cancelSave, dunningSave } = setup();
    db.addLine({ save_id: cancelSave().id, billing_month: "2026-09-01", amount_cents: 2_000 });
    db.addLine({ save_id: dunningSave().id, billing_month: "2026-09-01", amount_cents: 490 });
    stripe.failOn("addInvoiceItem", 1);
    expect(await billAccountForMonth(deps, "acc_1", "2026-09-01")).toMatchObject({ outcome: "failed" });
    expect(db.periods[0]).toMatchObject({ status: "failed", locked_at: null });

    stripe.failOn("finalizeInvoice", 1);
    expect(await billAccountForMonth(deps, "acc_1", "2026-09-01")).toMatchObject({ outcome: "failed" });

    expect(await billAccountForMonth(deps, "acc_1", "2026-09-01")).toMatchObject({ outcome: "invoiced", totalCents: 2_490 });
    expect(stripe.live()).toHaveLength(1);
    expect(stripe.live()[0]!.totalCents).toBe(2_490);
    expect(stripe.invoices.filter((i) => !i.deleted)).toHaveLength(1);
    expect(db.periods[0]!.attempts).toBe(3);
  });

  it("picks up an invoice that was finalized before a crash instead of creating another", async () => {
    const { db, stripe, deps, cancelSave } = setup();
    db.addLine({ save_id: cancelSave().id, billing_month: "2026-09-01", amount_cents: 2_000 });
    await billAccountForMonth(deps, "acc_1", "2026-09-01");
    // Simulate the crash: the row never learned it was invoiced.
    Object.assign(db.periods[0]!, { status: "failed" });
    expect(await billAccountForMonth(deps, "acc_1", "2026-09-01")).toMatchObject({ outcome: "invoiced" });
    expect(stripe.invoices).toHaveLength(1);
    expect(db.periods[0]!.status).toBe("invoiced");
  });

  it("doesn't let two runs work on the same month at once", async () => {
    const { db, deps, cancelSave } = setup();
    db.addLine({ save_id: cancelSave().id, billing_month: "2026-09-01", amount_cents: 2_000 });
    const period = await db.billing.ensurePeriod("acc_1", "2026-09-01", 29_900);
    await db.billing.lockPeriod(period.id, OCT_1.toISOString(), "2026-09-30T00:00:00Z"); // another run holds it
    expect(await billAccountForMonth(deps, "acc_1", "2026-09-01")).toMatchObject({ outcome: "locked" });
  });

  it("refuses to bill a month that hasn't ended", async () => {
    const { deps } = setup();
    await expect(runMonthlyBilling(deps, { month: "2026-10-01" })).rejects.toThrow(/hasn't ended/);
  });

  it("describes credits and the cap as negative invoice items", () => {
    const s = buildStatement([{ id: "1", saveId: "a", kind: "dunning", amountCents: 40_000, clawedBackCents: 0 }], 900);
    expect(invoiceItemsFor(s, "2026-09-01").map((i) => [i.key, i.amountCents])).toEqual([
      ["dunning", 40_000],
      ["cap", -10_100],
      ["credit", -900],
    ]);
  });
});
