/**
 * Overlap pricing (decided 2026-10-14): an invoice that earns both a
 * cancel-save fee and a failed-payment recovery fee pays the cancel-save fee
 * in full plus a 5% (not 10%) recovery fee. The cap and clawbacks still apply.
 */
import { describe, expect, it } from "vitest";
import { buildStatement, creditOwedCents } from "@/lib/billing/statement";
import { invoiceItemsFor } from "@/lib/billing/service";
import {
  calculateMonthlyBill,
  dunningSaveFeeCents,
  OVERLAP_RECOVERY_LABEL,
  OVERLAP_RECOVERY_RATE,
  OVERLAP_RECOVERY_RATE_BPS,
  overlapRecoveryFeeCents,
} from "@/lib/pricing";
import { processPaidInvoice, type PaidInvoiceEvent } from "@/lib/saves/verify";
import { applyInvoiceReversal } from "./clawbacks";
import { feeSummary, receiptEmail } from "./emails";
import { applyOverlapPricing } from "./overlap";
import { buildTimeline, feeLineViews, type ReceiptData } from "./receipt";
import { fakeLedger } from "./testing/fakes";

const ACCEPTED = new Date("2026-08-10T12:00:00Z");
const unix = (iso: string) => Date.parse(iso) / 1000;
const paid = (id: string, createdIso: string, over: Partial<PaidInvoiceEvent> = {}): PaidInvoiceEvent => ({
  id,
  subscriptionId: "sub_1",
  amountPaidCents: 7_000,
  createdUnix: unix(createdIso),
  billingReason: "subscription_cycle",
  customerEmail: "jamie@example.com",
  paidAt: new Date(createdIso),
  ...over,
});

function setup() {
  const db = fakeLedger({ clock: () => ACCEPTED });
  db.addAccount();
  // $70/mo saved by a cancel-flow offer.
  const cancel = db.addSave({ saved_mrr_cents: 7_000, created_at: ACCEPTED.toISOString() });
  return { db, cancel };
}

/** Unquit recovers a failed $70 invoice: dunning save + its 10% line, as recordRecovery writes them. */
function recovery(db: ReturnType<typeof fakeLedger>, invoiceId: string, amount = 7_000) {
  const save = db.addSave({
    type: "dunning",
    status: "verified",
    cancel_session_id: null,
    dunning_case_id: `case_${invoiceId}`,
    stripe_invoice_id: invoiceId,
    recovered_amount_cents: amount,
    saved_mrr_cents: 0,
    fee_cents: dunningSaveFeeCents(amount),
    attributed_via: "update_link",
    verified_at: "2026-09-02T10:00:00Z",
  });
  const line = db.addLine({ save_id: save.id, stripe_invoice_id: invoiceId, amount_cents: dunningSaveFeeCents(amount), invoice_amount_paid_cents: amount });
  return { save, line };
}

describe("pricing constants", () => {
  it("has a named 5% overlap rate, half the normal recovery rate, rounded down", () => {
    expect(OVERLAP_RECOVERY_RATE).toBe(0.05);
    expect(OVERLAP_RECOVERY_RATE_BPS).toBe(500);
    expect(overlapRecoveryFeeCents(7_000)).toBe(350);
    expect(overlapRecoveryFeeCents(1_999)).toBe(99); // 99.95 -> 99
    expect(overlapRecoveryFeeCents(0)).toBe(0);
    expect(overlapRecoveryFeeCents(12_345)).toBeLessThan(dunningSaveFeeCents(12_345));
    expect(() => overlapRecoveryFeeCents(-1)).toThrow(RangeError);
    expect(OVERLAP_RECOVERY_LABEL).toBe("Recovery fee (reduced, overlaps an active save): 5%");
  });
});

describe("how an overlap is billed", () => {
  it("recovery first (the usual webhook order): the invoice pays 20% + 5% instead of 20% + 10%", async () => {
    const { db, cancel } = setup();
    const { save: dunning, line } = recovery(db, "in_m1");
    // invoice.paid for the recovered invoice: verifies the cancel save (month 1) and applies the overlap.
    const result = await processPaidInvoice(db.repo, "acc_1", paid("in_m1", "2026-09-01T00:00:00Z"));
    expect(result.verified).toEqual([cancel.id]);
    expect(result.overlapReduced).toEqual([dunning.id]);

    const cancelLine = db.lines.find((l) => l.save_id === cancel.id)!;
    expect(cancelLine.amount_cents).toBe(1_400); // 20% of $70, in full
    expect(db.lines.find((l) => l.id === line.id)).toMatchObject({ amount_cents: 350, overlap_save_id: cancel.id }); // 5%, not $7.00
    expect(db.saves.get(dunning.id)!.fee_cents).toBe(350);
    expect(db.eventsFor(dunning.id)).toEqual(["overlap_reduced"]);
  });

  it("cancel line first, recovery recorded later: the next run applies it the same way", async () => {
    const { db, cancel } = setup();
    await processPaidInvoice(db.repo, "acc_1", paid("in_m1", "2026-09-01T00:00:00Z"));
    const { line } = recovery(db, "in_m1");
    const r = await applyOverlapPricing(db.repo, "acc_1", "in_m1", new Date("2026-09-02T00:00:00Z"));
    expect(r.reduced).toEqual([expect.objectContaining({ lineId: line.id, fromCents: 700, toCents: 350, overlapSaveId: cancel.id })]);
  });

  it("is idempotent: a re-delivered webhook reduces nothing twice and logs one event", async () => {
    const { db } = setup();
    const { save: dunning, line } = recovery(db, "in_m1");
    await processPaidInvoice(db.repo, "acc_1", paid("in_m1", "2026-09-01T00:00:00Z"));
    await processPaidInvoice(db.repo, "acc_1", paid("in_m1", "2026-09-01T00:00:00Z"));
    expect((await applyOverlapPricing(db.repo, "acc_1", "in_m1", ACCEPTED)).reduced).toEqual([]);
    expect(db.lines.find((l) => l.id === line.id)!.amount_cents).toBe(350);
    expect(db.eventsFor(dunning.id)).toEqual(["overlap_reduced"]);
  });

  it("applies in months 2 and 3 of the window, not after it", async () => {
    const { db } = setup();
    await processPaidInvoice(db.repo, "acc_1", paid("in_m1", "2026-09-01T00:00:00Z"));
    await processPaidInvoice(db.repo, "acc_1", paid("in_m2", "2026-10-01T00:00:00Z"));
    const m3 = recovery(db, "in_m3");
    await processPaidInvoice(db.repo, "acc_1", paid("in_m3", "2026-11-01T00:00:00Z"));
    expect(db.lines.find((l) => l.id === m3.line.id)!.amount_cents).toBe(350);

    // Month 4: the cancel save is free from now on, so a recovery there is a normal 10%.
    const m4 = recovery(db, "in_m4");
    await processPaidInvoice(db.repo, "acc_1", paid("in_m4", "2026-12-01T00:00:00Z"));
    expect(db.lines.find((l) => l.id === m4.line.id)).toMatchObject({ amount_cents: 700 });
    expect(db.lines.find((l) => l.id === m4.line.id)!.overlap_save_id ?? null).toBeNull();
  });

  it("changes nothing outside an overlap", async () => {
    const { db } = setup();
    // A recovery on an invoice that earns no cancel-save fee (different subscription, or $0 cancel line).
    const other = recovery(db, "in_other");
    await processPaidInvoice(db.repo, "acc_1", paid("in_other", "2026-09-01T00:00:00Z", { subscriptionId: "sub_2" }));
    expect(db.lines.find((l) => l.id === other.line.id)!.amount_cents).toBe(700);

    const db2 = setup().db;
    const lone = recovery(db2, "in_x");
    expect((await applyOverlapPricing(db2.repo, "acc_1", "in_x", ACCEPTED)).reduced).toEqual([]);
    expect(db2.lines.find((l) => l.id === lone.line.id)!.amount_cents).toBe(700);
  });

  it("never touches another account's lines", async () => {
    const { db } = setup();
    recovery(db, "in_m1");
    await processPaidInvoice(db.repo, "acc_1", paid("in_m1", "2026-09-01T00:00:00Z"));
    expect((await applyOverlapPricing(db.repo, "acc_other", "in_m1", ACCEPTED)).reduced).toEqual([]);
  });
});

describe("the cap and clawbacks still apply to overlaps", () => {
  it("counts the reduced line toward the $299 cap like any other fee", () => {
    // A big save (20% of $1,400 = $280) plus an overlapping $1,400 recovery at 5% ($70) = $350 > $299.
    const s = buildStatement([
      { id: "c", saveId: "a", kind: "cancel", amountCents: 28_000, clawedBackCents: 0 },
      { id: "d", saveId: "b", kind: "dunning", amountCents: overlapRecoveryFeeCents(140_000), clawedBackCents: 0, overlap: true },
    ]);
    expect(s).toMatchObject({
      cancelFeesCents: 28_000,
      dunningFeesCents: 7_000,
      overlapDunningFeesCents: 7_000,
      overlapDunningLinesCount: 1,
      grossCents: 35_000,
      capDiscountCents: 5_100,
      totalCents: 29_900,
      capReached: true,
    });
    const bill = calculateMonthlyBill([
      { saveId: "a", kind: "cancel", amountCents: 28_000 },
      { saveId: "b", kind: "dunning", amountCents: overlapRecoveryFeeCents(140_000) },
    ]);
    expect(bill.totalCents).toBe(29_900);
  });

  it("claws back the REDUCED fee pro-rata when the customer is refunded", async () => {
    const { db, cancel } = setup();
    const { line } = recovery(db, "in_m1");
    await processPaidInvoice(db.repo, "acc_1", paid("in_m1", "2026-09-01T00:00:00Z"));
    // Half the $70 invoice is refunded: both fees on it lose half.
    await applyInvoiceReversal(db.repo, "acc_1", { invoiceId: "in_m1", sourceKey: "charge:ch_1", kind: "refund", amountCents: 3_500 }, ACCEPTED);
    expect(db.lines.find((l) => l.id === line.id)).toMatchObject({ amount_cents: 350, clawed_back_cents: 175 });
    expect(db.lines.find((l) => l.save_id === cancel.id)).toMatchObject({ amount_cents: 1_400, clawed_back_cents: 700 });
  });

  it("an overlap found after the recovery was billed comes back as a credit on the next statement", () => {
    const billedAtFull = [{ id: "d", saveId: "b", kind: "dunning" as const, amountCents: 700, clawedBackCents: 0 }];
    const closed = { id: "p1", cappedCents: 700, capCents: 29_900, creditAppliedCents: 0 };
    expect(creditOwedCents([{ ...closed, lines: billedAtFull }])).toBe(0);
    const nowReduced = [{ ...billedAtFull[0]!, amountCents: 350, overlap: true }];
    expect(creditOwedCents([{ ...closed, lines: nowReduced }])).toBe(350);
  });
});

describe("receipts and statements say so", () => {
  it("itemises reduced recoveries separately on the invoice items", () => {
    const s = buildStatement([
      { id: "c", saveId: "a", kind: "cancel", amountCents: 1_400, clawedBackCents: 0 },
      { id: "d1", saveId: "b", kind: "dunning", amountCents: 700, clawedBackCents: 0 },
      { id: "d2", saveId: "e", kind: "dunning", amountCents: 350, clawedBackCents: 0, overlap: true },
    ]);
    const items = invoiceItemsFor(s, "2026-09-01");
    expect(items.map((i) => [i.key, i.amountCents])).toEqual([
      ["cancel", 1_400],
      ["dunning", 700],
      ["dunning_overlap", 350],
    ]);
    expect(items[1]!.description).toMatch(/1 × 10%/);
    expect(items[2]!.description).toContain(OVERLAP_RECOVERY_LABEL);
    expect(items.reduce((a, i) => a + i.amountCents, 0)).toBe(s.totalCents);
  });

  it("shows the reduced rate on the recovery's receipt timeline and fee lines", async () => {
    const { db, cancel } = setup();
    const { save } = recovery(db, "in_m1");
    await processPaidInvoice(db.repo, "acc_1", paid("in_m1", "2026-09-01T00:00:00Z"));
    const data: ReceiptData = {
      save: db.saves.get(save.id)!,
      session: null,
      dunningCase: null,
      lines: db.lines.filter((l) => l.save_id === save.id),
      clawbacks: [],
      events: db.events
        .filter((e) => e.saveId === save.id)
        .map((e) => ({ id: e.id, save_id: e.saveId, kind: e.kind, detail: e.detail ?? {}, occurred_at: e.occurredAt })),
      disputes: [],
      periods: [],
      stripeLivemode: false,
    };
    const timeline = buildTimeline(data);
    expect(timeline.find((t) => t.title === "Verified")!.detail).toContain(OVERLAP_RECOVERY_LABEL);
    const reduced = timeline.find((t) => t.title === "Recovery fee reduced to 5%")!;
    expect(reduced.detail).toContain(cancel.receipt_number);
    expect(reduced.detail).toContain("$7.00 → $3.50");
    expect(feeLineViews(data)[0]).toMatchObject({ overlap: true, amountCents: 350 });
  });
});

describe("the receipt email", () => {
  it("names the reduced rate for an overlapping recovery, and 10% otherwise", () => {
    const db = fakeLedger({ clock: () => ACCEPTED });
    const { save } = recovery(db, "in_1");
    const reduced = { ...db.saves.get(save.id)!, fee_cents: 350 };
    expect(feeSummary(reduced, { overlap: true })).toBe(`$3.50, once. ${OVERLAP_RECOVERY_LABEL} of the recovered amount, because this invoice also counts toward an active cancel save.`);
    expect(feeSummary(db.saves.get(save.id)!)).toBe("$7.00, once (10% of the recovered amount).");
    expect(receiptEmail(reduced, "https://app.unquit.test/r", { overlap: true }).text).toContain("reduced, overlaps an active save");
  });
});
