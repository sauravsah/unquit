/**
 * The SQL repos against a real Postgres (PGlite + the real migrations): the
 * compare-and-set and unique-constraint guarantees the services rely on
 * (their logic is tested with in-memory fakes elsewhere).
 */
import { beforeAll, describe, expect, it, vi } from "vitest";
import { addFounder, createTestDb, type TestDb } from "@/lib/db/testing/pglite";

vi.mock("server-only", () => ({}));
const { createLedgerRepo } = await import("@/lib/ledger/repo");
const { createDunningRepo, emailCaseId, recordEmailClick, recordEmailOpen, saveDunningSettings } = await import("@/lib/dunning/repo");
const { createWidgetRepo } = await import("@/lib/widget/repo");
const { createBillingRepo, ownerEmail } = await import("@/lib/billing/repo");
const { claimWebhookEvent, finishWebhookEvent } = await import("@/lib/stripe/webhook-events");
const { saveFlowRow, loadFlowRow } = await import("@/lib/flows/repo");
const { underRateLimit } = await import("@/lib/rate-limit");

let db: TestDb;
let acc = "";
let userEmail = "";
let userId = "";
const T0 = "2026-10-01T10:00:00.000Z";
const T1 = "2026-10-02T10:00:00.000Z";

beforeAll(async () => {
  db = await createTestDb();
  ({ accountId: acc, email: userEmail, userId } = await addFounder(db, { stripe: "acct_repo" }));
}, 60_000);

describe("widget repo", () => {
  it("runs a cancel session: accept once, one pending save, cooldown lookups", async () => {
    const repo = createWidgetRepo(db);
    expect(await repo.lastAcceptedAt(acc, "sub_w")).toBeNull();
    const session = await repo.createSession({ accountId: acc, customerId: "cus_w", subscriptionId: "sub_w", mrrAtStartCents: 4900, offersEnabled: true });
    expect(session).toMatchObject({ account_id: acc, status: "started", offer_accepted: false, offers_enabled: true });
    expect(await repo.getSession(acc, session.id)).toMatchObject({ id: session.id });
    expect(await repo.getSession("00000000-0000-0000-0000-000000000000", session.id)).toBeNull();

    const fields = { reason: "too_expensive", reasonLabel: "Too expensive", reasonDetail: null, offerShown: { type: "discount", percentOff: 30 }, acceptedAt: T0 };
    expect(await repo.markAccepted(session.id, fields)).toBe(true);
    expect(await repo.markAccepted(session.id, fields)).toBe(false); // compare-and-set
    expect(await repo.markCanceled(session.id, { ...fields, offerShown: null, cancelMode: "period_end", completedAt: T1 })).toBe(false);
    expect((await repo.getSession(acc, session.id))?.offer_shown).toEqual({ type: "discount", percentOff: 30 });

    const pending = { accountId: acc, cancelSessionId: session.id, customerId: "cus_w", subscriptionId: "sub_w", offer: { type: "discount" }, savedMrrCents: 3430, currency: "usd", createdAt: T0 };
    await repo.insertPendingSave(pending);
    await repo.insertPendingSave(pending);
    expect(await db.count("saves", `cancel_session_id = '${session.id}'`)).toBe(1);
    expect(await repo.lastAcceptedAt(acc, "sub_w")).toBe(T0);
    expect(await repo.lastAcceptedAt(acc, "sub_w", session.id)).toBeNull();
  });

  it("saves and loads a flow (jsonb reasons array round-trips)", async () => {
    const reasons = [{ id: "too_expensive", label: "Too expensive", offer: { type: "discount", percentOff: 30, months: 3 } }];
    await saveFlowRow(db, acc, { template: "custom", reasons, cancel_mode: "immediately", offer_cooldown_days: 30 });
    await saveFlowRow(db, acc, { template: "custom", reasons, cancel_mode: "period_end", offer_cooldown_days: 30 });
    expect(await loadFlowRow(db, acc)).toEqual({ template: "custom", reasons, cancel_mode: "period_end", offer_cooldown_days: 30 });
    expect((await createWidgetRepo(db).loadFlow(acc)).cancelMode).toBe("period_end");
  });
});

describe("ledger repo", () => {
  it("verifies, ends and loses saves with compare-and-set", async () => {
    const repo = createLedgerRepo(db);
    const [save] = await repo.savesForSubscription(acc, "sub_w", ["pending"]);
    expect(save).toBeDefined();
    expect(await repo.verifySave(save!.id, { verifiedAt: T1, invoiceId: "in_w", customerEmail: "c@example.com" })).toBe(true);
    expect(await repo.verifySave(save!.id, { verifiedAt: T1, invoiceId: "in_w", customerEmail: null })).toBe(false);
    expect(await repo.markLost(save!.id, "expired", T1)).toBe(false); // no longer pending
    expect(await repo.markEnded(save!.id, "customer_canceled", T1)).toBe(true);
    expect(await repo.markEnded(save!.id, "customer_canceled", T1)).toBe(false);
    const loaded = await repo.getSave(save!.id);
    expect(loaded).toMatchObject({ status: "verified", verified_at: T1, customer_email: "c@example.com", saved_mrr_cents: 3430, offer: { type: "discount" } });
    expect(await repo.setSaveStatus(save!.id, ["verified"], "disputed")).toBe(true);
    expect(await repo.setSaveStatus(save!.id, ["verified"], "disputed")).toBe(false);
    await repo.setSaveStatus(save!.id, ["disputed"], "verified");
  });

  it("fee lines: unique per month and invoice, clawbacks are compare-and-set, holds come back", async () => {
    const repo = createLedgerRepo(db);
    const [save] = await repo.savesForSubscription(acc, "sub_w", ["verified"]);
    const line = { save_id: save!.id, account_id: acc, month_index: 1, billing_month: "2026-10-01", stripe_invoice_id: "in_w", amount_cents: 686, invoice_amount_paid_cents: 3430, held_founder_dispute_id: null };
    const inserted = await repo.insertFeeLine(line);
    expect(inserted).toMatchObject({ amount_cents: 686, clawed_back_cents: 0, status: "earned", billing_month: "2026-10-01" });
    expect(await repo.insertFeeLine(line)).toBeNull();
    expect(await repo.insertFeeLine({ ...line, month_index: 2 })).toBeNull(); // same invoice
    expect(await repo.casClawedBack(inserted!.id, 0, 100, false)).toBe(true);
    expect(await repo.casClawedBack(inserted!.id, 0, 200, false)).toBe(false);
    expect((await repo.holdLinesForInvoice(acc, "in_w", "dp_1")).map((l) => l.id)).toEqual([inserted!.id]);
    expect((await repo.releaseStripeHold(acc, "dp_1"))[0]?.held_stripe_dispute_id).toBeNull();
    await repo.upsertReversal({ account_id: acc, stripe_invoice_id: "in_w", source_key: "charge:ch_1", kind: "refund", amount_cents: 500 });
    await repo.upsertReversal({ account_id: acc, stripe_invoice_id: "in_w", source_key: "charge:ch_1", kind: "refund", amount_cents: 900 });
    expect(await repo.reversalsForInvoice(acc, "in_w")).toEqual([{ account_id: acc, stripe_invoice_id: "in_w", source_key: "charge:ch_1", kind: "refund", amount_cents: 900 }]);
    await repo.insertClawback({ account_id: acc, save_id: save!.id, fee_line_id: inserted!.id, kind: "refund", source: "charge:ch_1", amount_cents: 100 });
    expect(await repo.clawbacksForSave(save!.id)).toHaveLength(1);
  });

  it("timeline events dedupe; disputes allow one open per save and resolve once", async () => {
    const repo = createLedgerRepo(db);
    const [save] = await repo.savesForSubscription(acc, "sub_w", ["verified"]);
    const e = { accountId: acc, saveId: save!.id, kind: "verified" as const, detail: { invoice: "in_w" }, dedupeKey: `verified:${save!.id}`, occurredAt: T1 };
    await repo.addEvent(e);
    await repo.addEvent(e);
    await repo.addEvent({ ...e, dedupeKey: undefined, kind: "fee_line" });
    expect(await db.count("save_events", `save_id = '${save!.id}'`)).toBe(2);

    const dispute = await repo.insertDispute({ save_id: save!.id, account_id: acc, opened_by: userId, reason: "x", category: "other", note: null, created_at: T1 });
    expect(dispute).toMatchObject({ status: "open", category: "other" });
    expect(await repo.insertDispute({ save_id: save!.id, account_id: acc, opened_by: null, reason: "y", category: "other", note: null, created_at: T1 })).toBeNull();
    expect((await repo.openDisputeForSave(save!.id))?.id).toBe(dispute!.id);
    await repo.setDisputeEvidence(dispute!.id, { checks: [{ invoice: "in_w", paid: true }] });
    expect((await repo.getDispute(dispute!.id))?.evidence).toEqual({ checks: [{ invoice: "in_w", paid: true }] });
    const res = { status: "rejected" as const, resolution: "admin" as const, note: "ok", resolvedBy: "admin@x.com", at: T1 };
    expect(await repo.resolveDispute(dispute!.id, res)).toBe(true);
    expect(await repo.resolveDispute(dispute!.id, res)).toBe(false);
  });

  it("claims receipt emails once and abandons stale cancel sessions", async () => {
    const repo = createLedgerRepo(db);
    const due = await repo.savesNeedingReceipt("2026-01-01T00:00:00.000Z", 10, acc);
    expect(due.length).toBeGreaterThan(0);
    expect(await repo.claimReceiptEmail(due[0]!.id, T1)).toBe(true);
    expect(await repo.claimReceiptEmail(due[0]!.id, T1)).toBe(false);
    await repo.releaseReceiptEmail(due[0]!.id, T1);
    expect(await repo.claimReceiptEmail(due[0]!.id, T1)).toBe(true);
    await db.query(`insert into cancel_sessions (account_id, stripe_customer_id, stripe_subscription_id, started_at) values ($1, 'c', 's', $2)`, [acc, T0]);
    expect(await repo.abandonSessionsStartedBefore(T1)).toBe(1);
    expect((await repo.getAccount(acc))?.stripe_account_id).toBe("acct_repo");
  });
});

describe("dunning repo", () => {
  const newCase = {
    account_id: "",
    stripe_invoice_id: "in_fail",
    stripe_customer_id: "cus_f",
    stripe_subscription_id: "sub_f",
    amount_due_cents: 4900,
    currency: "usd",
    attempt_count: 1,
    next_payment_attempt_at: null,
    hosted_invoice_url: null,
    customer_email: "c@example.com",
    customer_name: "Casey",
    invoice_number: "INV-1",
    decline_code: "insufficient_funds",
    decline_category: "soft" as const,
    last_failure_code: "card_declined",
    last_failure_message: "Declined",
    stripe_payment_intent_id: "pi_1",
    opened_at: T0,
    next_email_at: T0,
  };

  it("opens a case once, finds due cases only when dunning is on, and claims each email once", async () => {
    const repo = createDunningRepo(db);
    const c = await repo.insertCase({ ...newCase, account_id: acc });
    expect(c).toMatchObject({ status: "open", sequence_step: 0, amount_due_cents: 4900 });
    expect(await repo.insertCase({ ...newCase, account_id: acc })).toBeNull();
    expect((await repo.findCaseByInvoice(acc, "in_fail"))?.id).toBe(c!.id);
    expect((await repo.getCase(c!.id))?.account).toEqual({ id: acc, name: userEmail, stripe_account_id: "acct_repo", stripe_connection_mode: "connect", stripe_publishable_key: null, paused: false });

    expect(await repo.dueCases(new Date(T1), 10)).toEqual([]); // dunning is off by default
    await saveDunningSettings(db, acc, { enabled: true, schedule_days: [0, 3, 7], company_name: "Acme", reply_to_email: null, templates: {} });
    expect((await repo.getSettings(acc)).enabled).toBe(true);
    expect((await repo.dueCases(new Date(T1), 10)).map((x) => x.id)).toEqual([c!.id]);
    // Unquit paused for an unpaid bill (0011): no due cases, and the case knows it.
    await db.query("update accounts set billing_pause_state = 'paused', billing_pause_source = 'admin', billing_paused_at = now() where id = $1", [acc]);
    expect(await repo.dueCases(new Date(T1), 10)).toEqual([]);
    expect((await repo.getCase(c!.id))?.account.paused).toBe(true);
    await db.query("update accounts set billing_pause_state = 'active', billing_pause_source = null where id = $1", [acc]);
    expect((await repo.dueCases(new Date(T1), 10)).map((x) => x.id)).toEqual([c!.id]);

    const claim = { accountId: acc, caseId: c!.id, step: 0, category: "soft" as const, toEmail: "c@example.com", subject: "Payment failed" };
    const first = await repo.claimEmail(claim);
    expect(first.outcome).toBe("claimed");
    expect((await repo.claimEmail(claim)).outcome).toBe("in_flight");
    await repo.markEmailSent(first.emailId, { status: "logged", providerMessageId: "log_1", sentAt: T0 });
    expect(await repo.claimEmail(claim)).toEqual({ emailId: first.emailId, outcome: "already_sent" });
    expect(await repo.advanceSequence(c!.id, 0, T1, T0)).toBe(true);
    expect(await repo.advanceSequence(c!.id, 0, T1, T0)).toBe(false);

    expect(await emailCaseId(db, first.emailId)).toBe(c!.id);
    expect(await recordEmailClick(db, first.emailId)).toBe(true);
    await recordEmailOpen(db, first.emailId, T1);
    await repo.markLinkOpened(c!.id, T0);
    await repo.markLinkOpened(c!.id, T1);
    expect((await repo.getCase(c!.id))?.link_first_opened_at).toBe(T0);
  });

  it("records a recovery once, rotates the link nonce, and books one save + one fee line", async () => {
    const repo = createDunningRepo(db);
    const before = (await repo.findCaseByInvoice(acc, "in_fail"))!;
    await repo.setPendingAttribution(before.id, "update_link", T0);
    await repo.clearPendingAttribution(before.id, T1); // not the current mark: no-op
    expect((await repo.findCaseByInvoice(acc, "in_fail"))?.pending_attribution).toBe("update_link");
    expect(await repo.markRecovered(before.id, { via: "update_link", amountCents: 4900, at: T1 })).toBe(true);
    expect(await repo.markRecovered(before.id, { via: "update_link", amountCents: 4900, at: T1 })).toBe(false);
    const after = (await repo.findCaseByInvoice(acc, "in_fail"))!;
    expect(after.link_nonce).not.toBe(before.link_nonce);
    expect(after).toMatchObject({ status: "recovered", pending_attribution: null, next_email_at: null });

    const save = { accountId: acc, caseId: before.id, customerId: "cus_f", subscriptionId: "sub_f", invoiceId: "in_fail", recoveredAmountCents: 4900, currency: "usd", feeCents: 490, attributedVia: "update_link" as const, verifiedAt: T1, billingMonth: "2026-10-01" };
    await repo.upsertDunningSave(save);
    await repo.upsertDunningSave(save);
    expect(await db.count("saves", `dunning_case_id = '${before.id}'`)).toBe(1);
    expect(await db.count("save_fee_lines l join saves s on s.id = l.save_id", `s.dunning_case_id = '${before.id}'`)).toBe(1);
    expect(await repo.closeCasesForSubscription(acc, "sub_f", T1)).toBe(0); // already recovered
  });
});

describe("billing repo", () => {
  it("claims one period per month, locks it once, assigns unbilled lines and reads statement lines", async () => {
    const repo = createBillingRepo(db);
    expect(await repo.accountsToBill("2026-10-01")).toContain(acc);
    expect(await ownerEmail(db, userId)).toBe(userEmail);
    expect((await repo.getBillingAccount(acc))?.email).toBe(userEmail);

    const period = await repo.ensurePeriod(acc, "2026-10-01", 29_900);
    expect((await repo.ensurePeriod(acc, "2026-10-01", 29_900)).id).toBe(period.id);
    const locked = await repo.lockPeriod(period.id, T1, T0);
    expect(locked?.attempts).toBe(1);
    expect(await repo.lockPeriod(period.id, T1, T0)).toBeNull(); // a live run holds it
    expect((await repo.lockPeriod(period.id, "2026-10-02T11:00:00.000Z", "2026-10-02T10:30:00.000Z"))?.attempts).toBe(2); // stale lock

    await repo.assignLines(acc, period.id, "2026-10-01", T1);
    const lines = await repo.linesForPeriod(period.id);
    expect(lines.map((l) => l.kind).sort()).toEqual(["cancel", "dunning"]);
    await repo.updatePeriod(period.id, { status: "zero", locked_at: null });
    expect((await repo.closedPeriods(acc, "00000000-0000-0000-0000-000000000000")).map((p) => p.id)).toEqual([period.id]);

    expect(await repo.setPlatformCustomer(acc, "cus_plat_1")).toBe("cus_plat_1");
    expect(await repo.setPlatformCustomer(acc, "cus_plat_2")).toBe("cus_plat_1"); // first writer wins
  });
});

describe("webhook idempotency log and rate limits", () => {
  it("processes each event once and retries only failed ones", async () => {
    const event = { id: "evt_1", type: "invoice.paid", livemode: false, created: 1_790_000_000 } as never;
    expect(await claimWebhookEvent(db, event, { stripeAccountId: "acct_repo", retryFailed: true })).toBe("claimed");
    expect(await claimWebhookEvent(db, event, { stripeAccountId: "acct_repo", retryFailed: true })).toBe("duplicate");
    await finishWebhookEvent(db, "evt_1", "failed", "boom");
    expect(await claimWebhookEvent(db, event, { stripeAccountId: "acct_repo", retryFailed: true })).toBe("claimed");
    expect(await db.value("select attempts from webhook_events where stripe_event_id = 'evt_1'")).toBe(2);
    await finishWebhookEvent(db, "evt_1", "processed");
    expect(await claimWebhookEvent(db, event, { stripeAccountId: "acct_repo", retryFailed: true })).toBe("duplicate");
  });

  it("counts rate-limit hits and fails open when the counter is unavailable", async () => {
    expect([await underRateLimit(db, "t:1", 60, 1), await underRateLimit(db, "t:1", 60, 1)]).toEqual([true, false]);
    const broken = { query: async () => Promise.reject(new Error("down")) };
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await underRateLimit(broken, "t:2", 60, 1)).toBe(true);
    spy.mockRestore();
  });
});
