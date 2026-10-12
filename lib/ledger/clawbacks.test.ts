import { describe, expect, it } from "vitest";
import { applyInvoiceReversal, creditNoteNonRefundCents, handleStripeDispute } from "./clawbacks";
import { isHeld, monthFromSlug, netCents, previousMonthKey, proRataClawbackCents } from "./fees";
import { fakeLedger } from "./testing/fakes";

const NOW = new Date("2026-10-05T10:00:00Z");

function setup() {
  const db = fakeLedger({ clock: () => NOW });
  db.addAccount();
  const save = db.addSave({ status: "verified", verified_at: "2026-09-01T00:00:00Z", fee_cents: 4_000 });
  const m1 = db.addLine({ save_id: save.id, month_index: 1, stripe_invoice_id: "in_1", amount_cents: 2_000, invoice_amount_paid_cents: 10_000 });
  const m2 = db.addLine({ save_id: save.id, month_index: 2, stripe_invoice_id: "in_2", amount_cents: 2_000, invoice_amount_paid_cents: 10_000 });
  return { db, save, m1, m2 };
}

describe("pro-rata maths", () => {
  it("claws back the refunded share, rounded up (in the founder's favour), never more than the fee", () => {
    expect(proRataClawbackCents(2_000, 2_500, 10_000)).toBe(500); // 25% refund -> 25% of the fee
    expect(proRataClawbackCents(199, 1, 3)).toBe(67); // 66.33 -> 67
    expect(proRataClawbackCents(2_000, 10_000, 10_000)).toBe(2_000);
    expect(proRataClawbackCents(2_000, 99_999, 10_000)).toBe(2_000);
    expect(proRataClawbackCents(2_000, 0, 10_000)).toBe(0);
    expect(proRataClawbackCents(2_000, 1, 0)).toBe(2_000);
  });

  it("knows net, holds and months", () => {
    expect(netCents({ amount_cents: 2_000, clawed_back_cents: 500 })).toBe(1_500);
    expect(isHeld({ held_stripe_dispute_id: null, held_founder_dispute_id: null })).toBe(false);
    expect(isHeld({ held_stripe_dispute_id: "dp_1", held_founder_dispute_id: null })).toBe(true);
    expect(previousMonthKey("2026-01-01")).toBe("2025-12-01");
    expect(monthFromSlug("2026-09")).toBe("2026-09-01");
    expect(monthFromSlug("2026-13")).toBeNull();
  });
});

describe("refunds and credit notes claw back the fee line of that invoice", () => {
  it("partial refund: reverses pro-rata, only on the refunded invoice's line", async () => {
    const { db, save, m1, m2 } = setup();
    const r = await applyInvoiceReversal(db.repo, "acc_1", { invoiceId: "in_1", sourceKey: "charge:ch_1", kind: "refund", amountCents: 2_500 }, NOW);
    expect(r).toMatchObject({ matched: true, clawedBackCents: 500 });
    expect(db.lines.find((l) => l.id === m1.id)).toMatchObject({ clawed_back_cents: 500, status: "earned" });
    expect(db.lines.find((l) => l.id === m2.id)!.clawed_back_cents).toBe(0);
    expect(db.saves.get(save.id)).toMatchObject({ status: "verified", fee_cents: 3_500 });
    expect(db.clawbacks).toEqual([expect.objectContaining({ kind: "refund", amount_cents: 500, source: "charge:ch_1", fee_line_id: m1.id })]);
    expect(db.eventsFor(save.id)).toEqual(["refund"]);
  });

  it("is cumulative and idempotent: re-delivery adds nothing, a second refund adds the difference", async () => {
    const { db, m1 } = setup();
    const refund = (amount: number) =>
      applyInvoiceReversal(db.repo, "acc_1", { invoiceId: "in_1", sourceKey: "charge:ch_1", kind: "refund", amountCents: amount }, NOW);
    await refund(2_500);
    await refund(2_500); // same event again
    await refund(5_000); // a second partial refund: amount_refunded is now 50%
    expect(db.lines.find((l) => l.id === m1.id)!.clawed_back_cents).toBe(1_000);
    expect(db.clawbacks.map((c) => c.amount_cents)).toEqual([500, 500]);
  });

  it("full refund: the line is clawed back; the save too once every line is", async () => {
    const { db, save, m1 } = setup();
    await applyInvoiceReversal(db.repo, "acc_1", { invoiceId: "in_1", sourceKey: "charge:ch_1", kind: "refund", amountCents: 10_000 }, NOW);
    expect(db.lines.find((l) => l.id === m1.id)).toMatchObject({ clawed_back_cents: 2_000, status: "clawed_back" });
    expect(db.saves.get(save.id)!.status).toBe("verified"); // month 2 still stands
    await applyInvoiceReversal(db.repo, "acc_1", { invoiceId: "in_2", sourceKey: "charge:ch_2", kind: "refund", amountCents: 10_000 }, NOW);
    expect(db.saves.get(save.id)).toMatchObject({ status: "clawed_back", fee_cents: 0, clawed_back_at: NOW.toISOString() });
  });

  it("never double counts a credit note whose refund also fires charge.refunded", async () => {
    const { db, m1 } = setup();
    // A $30 credit note: $20 refunded to the card + $10 credited to the customer balance.
    const note = { status: "issued", post_payment_amount: 3_000, refunds: [{ amount_refunded: 2_000 }] };
    expect(creditNoteNonRefundCents(note)).toBe(1_000);
    await applyInvoiceReversal(db.repo, "acc_1", { invoiceId: "in_1", sourceKey: "credit_note:cn_1", kind: "credit_note", amountCents: creditNoteNonRefundCents(note) }, NOW);
    await applyInvoiceReversal(db.repo, "acc_1", { invoiceId: "in_1", sourceKey: "charge:ch_1", kind: "refund", amountCents: 2_000 }, NOW);
    expect(db.lines.find((l) => l.id === m1.id)!.clawed_back_cents).toBe(600); // 30% of $20
  });

  it("never re-charges when a credit note is voided", async () => {
    const { db, m1 } = setup();
    await applyInvoiceReversal(db.repo, "acc_1", { invoiceId: "in_1", sourceKey: "credit_note:cn_1", kind: "credit_note", amountCents: 5_000 }, NOW);
    const voided = creditNoteNonRefundCents({ status: "void", post_payment_amount: 5_000, refunds: [] });
    expect(voided).toBe(0);
    await applyInvoiceReversal(db.repo, "acc_1", { invoiceId: "in_1", sourceKey: "credit_note:cn_1", kind: "credit_note", amountCents: voided }, NOW);
    expect(db.lines.find((l) => l.id === m1.id)!.clawed_back_cents).toBe(1_000);
  });

  it("ignores invoices that earned no fee, and stores nothing for them", async () => {
    const { db } = setup();
    const r = await applyInvoiceReversal(db.repo, "acc_1", { invoiceId: "in_other", sourceKey: "charge:ch_9", kind: "refund", amountCents: 100 }, NOW);
    expect(r.matched).toBe(false);
    expect(db.reversals).toHaveLength(0);
  });

  it("asks Stripe for the invoice amount only when the line doesn't know it", async () => {
    const db = fakeLedger();
    db.addAccount();
    const save = db.addSave({ status: "verified", verified_at: "2026-09-01T00:00:00Z" });
    db.addLine({ save_id: save.id, stripe_invoice_id: "in_1", amount_cents: 2_000, invoice_amount_paid_cents: null });
    let lookups = 0;
    await applyInvoiceReversal(db.repo, "acc_1", { invoiceId: "in_1", sourceKey: "charge:ch_1", kind: "refund", amountCents: 1_000 }, NOW, async () => {
      lookups++;
      return 4_000;
    });
    expect(lookups).toBe(1);
    expect(db.lines[0]!.clawed_back_cents).toBe(500); // 25%
  });

  it("applies to dunning fee lines too", async () => {
    const db = fakeLedger();
    db.addAccount();
    const save = db.addSave({ type: "dunning", dunning_case_id: "case_1", cancel_session_id: null, status: "verified", verified_at: "2026-09-02T00:00:00Z", recovered_amount_cents: 4_900, fee_cents: 490 });
    db.addLine({ save_id: save.id, stripe_invoice_id: "in_d", amount_cents: 490, invoice_amount_paid_cents: 4_900 });
    await applyInvoiceReversal(db.repo, "acc_1", { invoiceId: "in_d", sourceKey: "charge:ch_d", kind: "refund", amountCents: 4_900 }, NOW);
    expect(db.saves.get(save.id)).toMatchObject({ status: "clawed_back", fee_cents: 0 });
  });
});

describe("Stripe disputes (chargebacks) hold the fee line", () => {
  it("holds while open, then releases it when the dispute is won", async () => {
    const { db, save, m1, m2 } = setup();
    expect(await handleStripeDispute(db.repo, "acc_1", { disputeId: "dp_1", invoiceId: "in_1", status: "needs_response", amountCents: 10_000 }, NOW)).toBe("held");
    expect(db.lines.find((l) => l.id === m1.id)!.held_stripe_dispute_id).toBe("dp_1");
    expect(db.lines.find((l) => l.id === m2.id)!.held_stripe_dispute_id).toBeNull();
    // updated -> under_review: still held, no duplicate timeline line
    await handleStripeDispute(db.repo, "acc_1", { disputeId: "dp_1", invoiceId: "in_1", status: "under_review", amountCents: 10_000 }, NOW);
    expect(await handleStripeDispute(db.repo, "acc_1", { disputeId: "dp_1", invoiceId: "in_1", status: "won", amountCents: 10_000 }, NOW)).toBe("released");
    expect(db.lines.find((l) => l.id === m1.id)).toMatchObject({ held_stripe_dispute_id: null, clawed_back_cents: 0 });
    expect(db.eventsFor(save.id)).toEqual(["stripe_dispute_opened", "stripe_dispute_won"]);
  });

  it("reverses the fee when the dispute is lost (pro-rata to the disputed amount) and lifts the hold", async () => {
    const { db, save, m1 } = setup();
    await handleStripeDispute(db.repo, "acc_1", { disputeId: "dp_1", invoiceId: "in_1", status: "needs_response", amountCents: 5_000 }, NOW);
    expect(await handleStripeDispute(db.repo, "acc_1", { disputeId: "dp_1", invoiceId: "in_1", status: "lost", amountCents: 5_000 }, NOW)).toBe("reversed");
    expect(db.lines.find((l) => l.id === m1.id)).toMatchObject({ clawed_back_cents: 1_000, held_stripe_dispute_id: null });
    expect(db.clawbacks).toEqual([expect.objectContaining({ kind: "dispute_lost", amount_cents: 1_000 })]);
    expect(db.eventsFor(save.id)).toEqual(["stripe_dispute_opened", "stripe_dispute_lost"]);
    // re-delivered "closed: lost" changes nothing
    await handleStripeDispute(db.repo, "acc_1", { disputeId: "dp_1", invoiceId: "in_1", status: "lost", amountCents: 5_000 }, NOW);
    expect(db.clawbacks).toHaveLength(1);
  });

  it("ignores disputes on invoices that earned no fee", async () => {
    const { db } = setup();
    expect(await handleStripeDispute(db.repo, "acc_1", { disputeId: "dp_9", invoiceId: "in_x", status: "needs_response", amountCents: 1 }, NOW)).toBe("unmatched");
  });
});
