import { describe, expect, it } from "vitest";
import { applyInvoiceReversal } from "./clawbacks";
import { DisputeError, evaluateEvidence, openDispute, parseDisputeInput, resolveDispute, sendReceiptEmails, type InvoiceEvidence, type LedgerDeps } from "./disputes";
import { fakeEvidence, fakeLedger, fakeMailer } from "./testing/fakes";

const NOW = new Date("2026-10-05T10:00:00Z");

const good = (id: string, over: Partial<InvoiceEvidence> = {}): InvoiceEvidence => ({
  id,
  status: "paid",
  amountPaidCents: 10_000,
  subscriptionId: "sub_1",
  customerId: "cus_1",
  refundedCents: 0,
  ...over,
});

function setup(evidence: Record<string, InvoiceEvidence | null> = { in_1: good("in_1"), in_2: good("in_2") }) {
  const db = fakeLedger({ clock: () => NOW });
  db.addAccount();
  const save = db.addSave({ status: "verified", verified_at: "2026-09-01T00:00:00Z", stripe_invoice_id: "in_1", fee_cents: 4_000, customer_email: "jamie@example.com" });
  db.addLine({ save_id: save.id, month_index: 1, stripe_invoice_id: "in_1", amount_cents: 2_000 });
  db.addLine({ save_id: save.id, month_index: 2, stripe_invoice_id: "in_2", amount_cents: 2_000 });
  const stripe = fakeEvidence(evidence);
  const mail = fakeMailer();
  const deps: LedgerDeps = { repo: db.repo, stripe: stripe.stripe, mailer: mail.mailer, appUrl: "https://app.unquit.test", now: () => NOW };
  return { db, save, stripe, mail, deps };
}

const open = (deps: LedgerDeps, saveId: string, category: string, note: string | null = null) =>
  openDispute(deps, { accountId: "acc_1", receiptSaveId: saveId, userId: "user_1", category, note });

describe("opening a dispute", () => {
  it("validates the reason and note", () => {
    expect(parseDisputeInput({ category: "would_have_stayed" })).toEqual({ ok: true, category: "would_have_stayed", note: null });
    expect(parseDisputeInput({ category: "nope" }).ok).toBe(false);
    expect(parseDisputeInput({ category: "other", note: "  " }).ok).toBe(false); // "Other" needs a note
    expect(parseDisputeInput({ category: "refunded", note: "x".repeat(2001) }).ok).toBe(false);
  });

  it("holds every fee line while open and sends it to the admin queue when the evidence holds up", async () => {
    const { db, save, mail, deps } = setup();
    const result = await open(deps, save.id, "would_have_stayed", "They told us they weren't leaving");
    expect(result.outcome).toBe("in_review");
    expect(result.evidence.failed).toEqual([]);
    expect(db.saves.get(save.id)!.status).toBe("disputed");
    expect(db.lines.every((l) => l.held_founder_dispute_id === result.dispute.id)).toBe(true);
    expect(db.disputes[0]).toMatchObject({ status: "open", category: "would_have_stayed", note: "They told us they weren't leaving", opened_by: "user_1" });
    expect(mail.admins).toHaveLength(1);
    expect(mail.admins[0]!.subject).toContain(save.receipt_number);
    expect(db.eventsFor(save.id)).toEqual(["dispute_opened"]);
  });

  it("allows one open dispute per save, and none on pending, lost or reversed saves", async () => {
    const { db, save, deps } = setup();
    await open(deps, save.id, "would_have_stayed");
    await expect(open(deps, save.id, "would_have_stayed")).rejects.toMatchObject({ code: "already_open" });
    const pending = db.addSave({ status: "pending" });
    await expect(open(deps, pending.id, "other", "x")).rejects.toMatchObject({ code: "no_fee" });
    const lost = db.addSave({ status: "lost", lost_at: NOW.toISOString(), lost_reason: "expired" });
    await expect(open(deps, lost.id, "other", "x")).rejects.toBeInstanceOf(DisputeError);
  });

  it("refuses another founder's save", async () => {
    const { db, deps } = setup();
    db.addAccount({ id: "acc_2" });
    const theirs = db.addSave({ account_id: "acc_2", status: "verified", verified_at: NOW.toISOString() });
    await expect(open(deps, theirs.id, "wrong_customer")).rejects.toMatchObject({ status: 404 });
  });
});

describe("dispute auto-rules: failed evidence resolves in the founder's favour", () => {
  it.each([
    ["no paid invoice", { in_1: good("in_1", { status: "open", amountPaidCents: 0 }), in_2: good("in_2") }, "no_paid_invoice"],
    ["invoice missing", { in_1: null, in_2: good("in_2") }, "no_paid_invoice"],
    ["refunded", { in_1: good("in_1"), in_2: good("in_2", { refundedCents: 500 }) }, "refunded"],
    ["not on that subscription", { in_1: good("in_1", { subscriptionId: "sub_other" }), in_2: good("in_2") }, "wrong_subscription"],
    ["different customer", { in_1: good("in_1", { customerId: "cus_other" }), in_2: good("in_2") }, "wrong_customer"],
  ])("%s -> accepted automatically, every fee reversed", async (_label, evidence, failure) => {
    const { db, save, mail, deps } = setup(evidence as Record<string, InvoiceEvidence | null>);
    const result = await open(deps, save.id, "would_have_stayed");
    expect(result.outcome).toBe("auto_accepted");
    expect(result.evidence.failed).toContain(failure);
    expect(result.dispute).toMatchObject({ status: "accepted", resolution: "auto", resolved_by: "auto-rules" });
    expect(db.saves.get(save.id)).toMatchObject({ status: "clawed_back", fee_cents: 0 });
    expect(db.lines.every((l) => l.clawed_back_cents === l.amount_cents && l.status === "clawed_back" && !l.held_founder_dispute_id)).toBe(true);
    expect(db.clawbacks.every((c) => c.kind === "dispute_auto")).toBe(true);
    expect(mail.founder).toHaveLength(1);
    expect(mail.founder[0]!.subject).toMatch(/accepted/);
    expect(mail.admins).toHaveLength(0); // nothing left to review
    expect(db.disputes[0]!.founder_notified_at).toBe(NOW.toISOString());
  });

  it("also counts refunds unquit already recorded from webhooks", async () => {
    const { db, save, deps } = setup();
    await applyInvoiceReversal(db.repo, "acc_1", { invoiceId: "in_1", sourceKey: "charge:ch_1", kind: "refund", amountCents: 100 }, NOW);
    expect((await open(deps, save.id, "refunded")).outcome).toBe("auto_accepted");
  });

  it("leaves it for a human when Stripe can't be reached", async () => {
    const { save, stripe, deps } = setup();
    stripe.fail();
    const result = await open(deps, save.id, "would_have_stayed");
    expect(result.outcome).toBe("in_review");
    expect(result.evidence.error).toMatch(/Stripe lookup failed/);
  });

  it("evaluateEvidence flags a save with no invoices at all", () => {
    expect(evaluateEvidence({ stripe_subscription_id: "sub_1", stripe_customer_id: "cus_1" }, [], new Map()).failed).toEqual(["no_paid_invoice"]);
  });
});

describe("admin decisions", () => {
  it("accept: fees reversed, the founder sees it and gets an email", async () => {
    const { db, save, mail, deps } = setup();
    const { dispute } = await open(deps, save.id, "would_have_stayed");
    const resolved = await resolveDispute(deps, { disputeId: dispute.id, decision: "accept", note: "Fair point", resolvedBy: "admin@unquit.test" });
    expect(resolved).toMatchObject({ status: "accepted", resolution: "admin", resolution_note: "Fair point", resolved_by: "admin@unquit.test" });
    expect(db.saves.get(save.id)).toMatchObject({ status: "clawed_back", fee_cents: 0 });
    expect(db.clawbacks.map((c) => [c.kind, c.amount_cents])).toEqual([
      ["dispute_accepted", 2_000],
      ["dispute_accepted", 2_000],
    ]);
    expect(mail.founder[0]!.text).toContain("Fair point");
    expect(db.eventsFor(save.id)).toEqual(["dispute_opened", "dispute_accepted"]);
  });

  it("reject (with a note): holds released, the fee stands, the founder is told why", async () => {
    const { db, save, mail, deps } = setup();
    const { dispute } = await open(deps, save.id, "would_have_stayed");
    await expect(resolveDispute(deps, { disputeId: dispute.id, decision: "reject", note: " ", resolvedBy: "a" })).rejects.toMatchObject({ code: "note_required" });
    await resolveDispute(deps, { disputeId: dispute.id, decision: "reject", note: "They paid 2 more months", resolvedBy: "admin@unquit.test" });
    expect(db.saves.get(save.id)).toMatchObject({ status: "verified", fee_cents: 4_000 });
    expect(db.lines.every((l) => l.held_founder_dispute_id === null && l.clawed_back_cents === 0)).toBe(true);
    expect(mail.founder[0]!.subject).toMatch(/stands/);
    expect(mail.founder[0]!.text).toContain("They paid 2 more months");
  });

  it("resolves once: a second decision is refused", async () => {
    const { save, deps } = setup();
    const { dispute } = await open(deps, save.id, "would_have_stayed");
    await resolveDispute(deps, { disputeId: dispute.id, decision: "accept", note: null, resolvedBy: "a" });
    await expect(resolveDispute(deps, { disputeId: dispute.id, decision: "reject", note: "no", resolvedBy: "b" })).rejects.toMatchObject({
      code: "already_resolved",
    });
  });

  it("a refund that arrived during the dispute still counts after a rejection", async () => {
    const { db, save, deps } = setup();
    const { dispute } = await open(deps, save.id, "would_have_stayed");
    await applyInvoiceReversal(db.repo, "acc_1", { invoiceId: "in_2", sourceKey: "charge:ch_2", kind: "refund", amountCents: 5_000 }, NOW);
    await resolveDispute(deps, { disputeId: dispute.id, decision: "reject", note: "Save is real", resolvedBy: "a" });
    expect(db.saves.get(save.id)).toMatchObject({ status: "verified", fee_cents: 3_000 });
  });
});

describe("receipt emails", () => {
  it("emails each verified save once, and retries a failed send", async () => {
    const { db, save, mail, deps } = setup();
    db.saves.get(save.id)!.verified_at = "2026-10-04T09:00:00.000Z";
    const old = db.addSave({ status: "verified", verified_at: "2026-08-01T00:00:00.000Z" }); // before receipts existed
    mail.failNext();
    expect(await sendReceiptEmails(deps)).toEqual({ sent: 0, failed: 1 });
    expect(db.saves.get(save.id)!.receipt_emailed_at).toBeNull();
    expect(await sendReceiptEmails(deps)).toEqual({ sent: 1, failed: 0 });
    expect(await sendReceiptEmails(deps)).toEqual({ sent: 0, failed: 0 });
    expect(mail.founder).toHaveLength(1);
    expect(mail.founder[0]!.subject).toContain(save.receipt_number);
    expect(mail.founder[0]!.html).toContain(`https://app.unquit.test/dashboard/saves/${save.receipt_number}`);
    expect(mail.founder[0]!.text).toContain("Dispute");
    expect(db.saves.get(old.id)!.receipt_emailed_at).toBeNull();
  });
});

describe("daily ledger jobs", async () => {
  const { runDailyLedgerJobs } = await import("./jobs");
  const { fakeBillingStripe } = await import("./testing/fakes");
  it("expires stale pending saves, abandons old sessions, sends receipts and catches up last month's bill, idempotently", async () => {
    const now = new Date("2026-10-02T15:00:00Z");
    const db = fakeLedger({ clock: () => now });
    db.addAccount();
    const stale = db.addSave({ created_at: "2026-08-01T00:00:00Z" });
    const verified = db.addSave({ status: "verified", verified_at: "2026-10-01T10:00:00Z" });
    db.addLine({ save_id: verified.id, billing_month: "2026-09-01", amount_cents: 2_000 });
    db.addSession({ started_at: "2026-09-30T00:00:00Z" });
    const mail = fakeMailer();
    const stripe = fakeBillingStripe();
    const deps: LedgerDeps = { repo: db.repo, mailer: mail.mailer, appUrl: "https://app.unquit.test", now: () => now };
    const billing = { repo: db.billing, stripe: stripe.stripe, appUrl: "https://app.unquit.test", now: () => now };

    const first = await runDailyLedgerJobs(deps, { verifyWindowDays: 45, billing, now });
    expect(first).toMatchObject({ expiredSaves: 1, abandonedSessions: 1, receipts: { sent: 1, failed: 0 }, billing: { month: "2026-09-01", invoiced: 1 } });
    expect(db.saves.get(stale.id)!.status).toBe("lost");

    const second = await runDailyLedgerJobs(deps, { verifyWindowDays: 45, billing, now });
    expect(second).toMatchObject({ expiredSaves: 0, abandonedSessions: 0, receipts: { sent: 0 }, billing: { already_done: 1 } });
    expect(stripe.invoices).toHaveLength(1);
  });
});
