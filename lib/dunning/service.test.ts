import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
import { MONTHLY_FEE_CAP_CENTS, applyMonthlyCap } from "@/lib/pricing";
import { ATTRIBUTION_WINDOW_MS } from "./attribution";
import {
  companyNameFor,
  formatFrom,
  openOrUpdateCase,
  processCase,
  recordRecovery,
  runDunningForCase,
  runDunningSequence,
  stopForCanceledSubscription,
  type SequenceDeps,
} from "./service";
import { settingsFromRow } from "./settings";
import { fakeEmail, fakeLiveStripe, fakeRepo } from "./testing/fakes";
import { verifyLinkToken } from "./token";
import type { FailedInvoice } from "./types";

const DAY = 86_400_000;
const SECRET = "test-link-secret-0123456789abcdef0123456789";
const T0 = new Date("2026-10-01T10:00:00Z");

function setup(opts: { live?: boolean } = {}) {
  let now = T0;
  const clock = () => now;
  const db = fakeRepo({ clock });
  const mail = fakeEmail({ live: opts.live });
  const stripe = fakeLiveStripe();
  const logs: string[] = [];
  const deps: SequenceDeps = {
    repo: db.repo,
    stripe: stripe.stripe,
    email: mail.client,
    config: { appUrl: "https://app.unquit.test", linkSecret: SECRET, fromAddress: "billing@mail.unquit.test" },
    now: clock,
    log: (l) => logs.push(l),
  };
  return {
    db,
    mail,
    stripe,
    deps,
    logs,
    at(ms: number) {
      now = new Date(T0.getTime() + ms);
    },
  };
}

const failed = (over: Partial<FailedInvoice> = {}): FailedInvoice => ({
  id: "in_1",
  customerId: "cus_1",
  subscriptionId: "sub_1",
  amountDueCents: 4_900,
  currency: "usd",
  attemptCount: 1,
  nextPaymentAttemptAt: null,
  hostedInvoiceUrl: "https://invoice.stripe.com/i/1",
  customerEmail: "jamie@example.com",
  customerName: "Jamie Rivera",
  number: "ACME-0042",
  declineCode: "expired_card",
  errorCode: "card_declined",
  failureMessage: "Your card has expired.",
  paymentIntentId: "pi_1",
  ...over,
});

describe("invoice.payment_failed opens or updates the case", () => {
  it("opens a case with the decline code, category and first email due at day 0", async () => {
    const { db } = setup();
    const result = await openOrUpdateCase(db.repo, "acc_1", failed(), T0);
    expect(result).toMatchObject({ created: true, category: "hard" });
    const c = db.cases.get(result.caseId!)!;
    expect(c).toMatchObject({
      status: "open",
      decline_code: "expired_card",
      decline_category: "hard",
      customer_email: "jamie@example.com",
      invoice_number: "ACME-0042",
      next_email_at: T0.toISOString(),
      sequence_step: 0,
    });
  });

  it("uses the account's schedule for the first email", async () => {
    const { db } = setup();
    db.settings.set("acc_1", { ...settingsFromRow(null), enabled: true, companyName: "Acme", scheduleDays: [1, 4, 9] });
    const { caseId } = await openOrUpdateCase(db.repo, "acc_1", failed(), T0);
    expect(db.cases.get(caseId!)!.next_email_at).toBe(new Date(T0.getTime() + DAY).toISOString());
  });

  it("updates the decline on a later failure without restarting the sequence", async () => {
    const { db } = setup();
    const { caseId } = await openOrUpdateCase(db.repo, "acc_1", failed({ declineCode: "insufficient_funds" }), T0);
    expect(db.cases.get(caseId!)!.decline_category).toBe("soft");
    db.cases.get(caseId!)!.sequence_step = 1;
    const again = await openOrUpdateCase(db.repo, "acc_1", failed({ declineCode: "authentication_required", attemptCount: 2 }), new Date(T0.getTime() + 3 * DAY));
    expect(again).toMatchObject({ created: false, caseId, category: "authentication_required" });
    expect(db.cases.get(caseId!)).toMatchObject({ decline_category: "authentication_required", sequence_step: 1, opened_at: T0.toISOString() });
  });

  it("never reopens a recovered case", async () => {
    const { db } = setup();
    const c = db.addCase({ stripe_invoice_id: "in_1", status: "recovered", decline_code: "expired_card" });
    await openOrUpdateCase(db.repo, "acc_1", failed({ declineCode: "insufficient_funds" }), T0);
    expect(db.cases.get(c.id)).toMatchObject({ status: "recovered", decline_code: "expired_card" });
  });
});

describe("the email sequence (cron)", () => {
  it("sends day 0, 3 and 7, each with a working card-update link, then completes", async () => {
    const t = setup();
    const { caseId } = await openOrUpdateCase(t.db.repo, "acc_1", failed(), T0);

    expect(await runDunningSequence(t.deps)).toMatchObject({ considered: 1, sent: 1 });
    t.at(2 * DAY);
    expect(await runDunningSequence(t.deps)).toEqual({ considered: 0 });
    t.at(3 * DAY);
    expect(await runDunningSequence(t.deps)).toMatchObject({ sent: 1 });
    t.at(7 * DAY);
    expect(await runDunningSequence(t.deps)).toMatchObject({ sent: 1 });
    t.at(14 * DAY);
    expect(await runDunningSequence(t.deps)).toEqual({ considered: 0 });

    expect(t.mail.sent.map((m) => m.subject)).toEqual([
      "Please update your card for Acme",
      "Reminder: your card for Acme needs updating",
      "Your Acme subscription is at risk",
    ]);
    const c = t.db.cases.get(caseId!)!;
    expect(c).toMatchObject({ sequence_step: 3, next_email_at: null, sequence_stop_reason: "completed" });
    expect(t.db.emails.map((e) => [e.step, e.status])).toEqual([[0, "sent"], [1, "sent"], [2, "sent"]]);

    const first = t.mail.sent[0]!;
    expect(first.from).toBe('"Acme" <billing@mail.unquit.test>');
    expect(first.to).toBe("jamie@example.com");
    expect(first.idempotencyKey).toBe(`dunning/${caseId}/0`);
    expect(first.text).toContain("Hi Jamie,");
    expect(first.text).toContain("$49.00");
    const link = /https:\/\/app\.unquit\.test\/api\/dunning\/click\/([0-9a-f-]+)\?t=([^\s"]+)/.exec(first.text)!;
    expect(link[1]).toBe(t.db.emails[0]!.id);
    const verified = verifyLinkToken(decodeURIComponent(link[2]!), SECRET, T0);
    expect(verified).toMatchObject({ ok: true, payload: { caseId, nonce: c.link_nonce } });
    expect(first.html).toContain(`https://app.unquit.test/api/dunning/open/${t.db.emails[0]!.id}`);
  });

  it("picks the copy by decline category", async () => {
    const t = setup();
    await openOrUpdateCase(t.db.repo, "acc_1", failed({ id: "in_soft", declineCode: "insufficient_funds" }), T0);
    await openOrUpdateCase(t.db.repo, "acc_1", failed({ id: "in_sca", declineCode: "authentication_required" }), T0);
    await runDunningSequence(t.deps);
    expect(t.mail.sent.map((m) => m.subject).sort()).toEqual(["Please confirm your Acme payment", "Your Acme payment didn't go through"]);
    expect(t.mail.sent.find((m) => m.subject.startsWith("Your Acme"))!.text).toMatch(/don't need to do anything/);
  });

  it("uses the founder's edited template", async () => {
    const t = setup();
    const base = settingsFromRow(null);
    base.templates.hard[0] = { subject: "{{company}}: card problem", body: "Hey {{customer_name}}, {{amount}} is due. {{update_link}}" };
    t.db.settings.set("acc_1", { ...base, enabled: true, companyName: "Acme" });
    await openOrUpdateCase(t.db.repo, "acc_1", failed(), T0);
    await runDunningSequence(t.deps);
    expect(t.mail.sent[0]!.subject).toBe("Acme: card problem");
    expect(t.mail.sent[0]!.text).toMatch(/^Hey Jamie, \$49\.00 is due\. https:\/\/app\.unquit\.test\/api\/dunning\/click\//);
  });

  it("is idempotent: running twice (or concurrently) never double-sends", async () => {
    const t = setup();
    await openOrUpdateCase(t.db.repo, "acc_1", failed(), T0);
    const [a, b] = await Promise.all([runDunningSequence(t.deps), runDunningSequence(t.deps)]);
    await runDunningSequence(t.deps);
    expect(t.mail.sent).toHaveLength(1);
    expect(t.db.emails).toHaveLength(1);
    expect((a.sent ?? 0) + (b.sent ?? 0)).toBe(1);
  });

  it("recovers from a run that crashed after sending but before moving on", async () => {
    const t = setup();
    const c = t.db.addCase();
    // Simulate: the email was claimed and sent, then the run died.
    const claim = await t.db.repo.claimEmail({ accountId: "acc_1", caseId: c.id, step: 0, category: "hard", toEmail: "x@y.z", subject: "s" });
    await t.db.repo.markEmailSent(claim.emailId, { status: "sent", providerMessageId: "re_1", sentAt: T0.toISOString() });
    expect(await runDunningSequence(t.deps)).toMatchObject({ already_sent: 1 });
    expect(t.mail.sent).toHaveLength(0);
    expect(t.db.cases.get(c.id)!.sequence_step).toBe(1);
  });

  it("doesn't touch an email another run is sending right now", async () => {
    const t = setup();
    const c = t.db.addCase();
    await t.db.repo.claimEmail({ accountId: "acc_1", caseId: c.id, step: 0, category: "hard", toEmail: "x@y.z", subject: "s" });
    expect(await runDunningSequence(t.deps)).toMatchObject({ in_flight: 1 });
    expect(t.mail.sent).toHaveLength(0);
    expect(t.db.cases.get(c.id)!.sequence_step).toBe(0);
  });

  it("retries a failed send on the next run, up to 3 attempts", async () => {
    const t = setup();
    const c = t.db.addCase();
    t.mail.failNext(3);
    expect(await runDunningSequence(t.deps)).toMatchObject({ failed: 1 });
    expect(await runDunningSequence(t.deps)).toMatchObject({ failed: 1 });
    expect(await runDunningSequence(t.deps)).toMatchObject({ failed: 1 });
    expect(await runDunningSequence(t.deps)).toMatchObject({ gave_up: 1 });
    expect(t.mail.sent).toHaveLength(0);
    expect(t.db.cases.get(c.id)!.sequence_step).toBe(1); // moves on to email 2
    expect(t.logs.some((l) => l.includes("will retry"))).toBe(true);

    const t2 = setup();
    t2.db.addCase();
    t2.mail.failNext(1);
    await runDunningSequence(t2.deps);
    expect(await runDunningSequence(t2.deps)).toMatchObject({ sent: 1 });
    expect(t2.db.emails[0]).toMatchObject({ status: "sent", attempts: 2 });
  });

  it("stops the sequence the moment the invoice is paid", async () => {
    const t = setup();
    const { caseId } = await openOrUpdateCase(t.db.repo, "acc_1", failed(), T0);
    await runDunningSequence(t.deps);
    await recordRecovery(t.db.repo, "acc_1", { id: "in_1", amountPaidCents: 4_900, paidAt: new Date(T0.getTime() + DAY) });
    t.at(3 * DAY);
    expect(await runDunningSequence(t.deps)).toEqual({ considered: 0 });
    expect(t.mail.sent).toHaveLength(1);
    expect(t.db.cases.get(caseId!)).toMatchObject({ status: "recovered", next_email_at: null, sequence_stop_reason: "paid" });
  });

  it("stops when Stripe already shows the invoice paid, even before the webhook arrives", async () => {
    const t = setup();
    const c = t.db.addCase();
    t.stripe.state.invoiceStatus = "paid";
    expect(await runDunningSequence(t.deps)).toMatchObject({ stopped: 1 });
    expect(t.mail.sent).toHaveLength(0);
    expect(t.db.cases.get(c.id)).toMatchObject({ status: "open", next_email_at: null, sequence_stop_reason: "paid" });
  });

  it("stops when the subscription is cancelled (webhook)", async () => {
    const t = setup();
    const c = t.db.addCase();
    const other = t.db.addCase({ stripe_subscription_id: "sub_other" });
    expect(await stopForCanceledSubscription(t.db.repo, "acc_1", "sub_1", T0)).toBe(1);
    await runDunningSequence(t.deps);
    expect(t.db.cases.get(c.id)).toMatchObject({ status: "closed", sequence_stop_reason: "canceled", next_email_at: null });
    expect(t.mail.sent.map((m) => m.idempotencyKey)).toEqual([`dunning/${other.id}/0`]);
  });

  it("stops when Stripe shows the subscription cancelled", async () => {
    const t = setup();
    const c = t.db.addCase();
    t.stripe.state.subscriptionStatus = "canceled";
    await runDunningSequence(t.deps);
    expect(t.mail.sent).toHaveLength(0);
    expect(t.db.cases.get(c.id)!.sequence_stop_reason).toBe("canceled");
  });

  it("skips cases when Stripe can't be reached, and tries again next run", async () => {
    const t = setup();
    t.db.addCase();
    t.stripe.state.throws = true;
    expect(await runDunningSequence(t.deps)).toMatchObject({ failed: 1 });
    t.stripe.state.throws = false;
    expect(await runDunningSequence(t.deps)).toMatchObject({ sent: 1 });
  });

  it("sends nothing while dunning is switched off for the account", async () => {
    const t = setup();
    t.db.settings.set("acc_1", { ...settingsFromRow(null), enabled: false, companyName: "Acme" });
    t.db.addCase();
    expect(await runDunningSequence(t.deps)).toEqual({ considered: 0 });
    expect(t.mail.sent).toHaveLength(0);
  });

  it("logs instead of sending when there's no RESEND_API_KEY, and still moves on", async () => {
    const t = setup({ live: false });
    const c = t.db.addCase();
    expect(await runDunningSequence(t.deps)).toMatchObject({ logged: 1 });
    expect(t.db.emails[0]!.status).toBe("logged");
    expect(t.db.cases.get(c.id)!.sequence_step).toBe(1);
  });

  it("sends the day-0 email straight away for a new case", async () => {
    const t = setup();
    const { caseId } = await openOrUpdateCase(t.db.repo, "acc_1", failed(), T0);
    expect(await runDunningForCase(t.deps, caseId!)).toBe("sent");
    expect(await runDunningSequence(t.deps)).toEqual({ considered: 0 }); // the cron finds nothing left to do
    expect(t.mail.sent).toHaveLength(1);
  });

  it("stops a case without a customer email", async () => {
    const t = setup();
    const c = t.db.addCase({ customer_email: null });
    const settings = await t.db.repo.getSettings("acc_1");
    expect(await processCase(t.deps, (await t.db.repo.getCase(c.id))!, settings)).toBe("stopped");
    expect(t.db.cases.get(c.id)!.sequence_stop_reason).toBe("no_email");
  });
});

describe("sender name", () => {
  it("uses the company name from settings, else a non-email account name", () => {
    const s = settingsFromRow(null);
    expect(companyNameFor({ ...s, companyName: "Acme" }, { name: "x@y.z" })).toBe("Acme");
    expect(companyNameFor(s, { name: "Acme Ltd" })).toBe("Acme Ltd");
    expect(companyNameFor(s, { name: "founder@acme.com" })).toBe("Your subscription");
  });

  it("can't break the From header", () => {
    expect(formatFrom('Evil" <x@evil.com>\r\nBcc: y', "billing@mail.test")).toBe('"Evil x@evil.comBcc: y" <billing@mail.test>');
  });
});

describe("attribution and fees on invoice.paid", () => {
  it("records a billable dunning save when paid through the update page", async () => {
    const t = setup();
    const c = t.db.addCase({ link_first_opened_at: T0.toISOString() });
    await t.db.repo.setPendingAttribution(c.id, "update_link", T0.toISOString());
    const result = await recordRecovery(t.db.repo, "acc_1", { id: c.stripe_invoice_id, amountPaidCents: 4_900, paidAt: new Date(T0.getTime() + 5_000) });
    expect(result).toMatchObject({ recorded: true, won: true, saveRecorded: true, attribution: { via: "update_link", feeCents: 490 } });
    expect(t.db.saves).toEqual([
      expect.objectContaining({ caseId: c.id, attributedVia: "update_link", recoveredAmountCents: 4_900, feeCents: 490, billingMonth: "2026-10-01" }),
    ]);
    expect(t.db.feeLines).toEqual([{ caseId: c.id, amountCents: 490, billingMonth: "2026-10-01" }]);
    const after = t.db.cases.get(c.id)!;
    expect(after).toMatchObject({ status: "recovered", recovered_via: "update_link", pending_attribution: null });
    expect(after.link_nonce).not.toBe(c.link_nonce); // every link for this case is now dead
  });

  it("records an unquit_retry save after an email click", async () => {
    const t = setup();
    const c = t.db.addCase({ link_first_opened_at: T0.toISOString() });
    await t.db.repo.setPendingAttribution(c.id, "unquit_retry", new Date(T0.getTime() + 1000).toISOString());
    await recordRecovery(t.db.repo, "acc_1", { id: c.stripe_invoice_id, amountPaidCents: 12_000, paidAt: new Date(T0.getTime() + 2000) });
    expect(t.db.saves[0]).toMatchObject({ attributedVia: "unquit_retry", feeCents: 1_200 });
  });

  it("keeps Stripe's own recoveries external, with no save and no fee", async () => {
    const t = setup();
    const c = t.db.addCase({ link_first_opened_at: T0.toISOString() }); // even if the customer clicked
    const result = await recordRecovery(t.db.repo, "acc_1", { id: c.stripe_invoice_id, amountPaidCents: 4_900, paidAt: T0 });
    expect(result).toMatchObject({ recorded: true, saveRecorded: false, attribution: { via: "external", feeCents: 0 } });
    expect(t.db.saves).toEqual([]);
    expect(t.db.cases.get(c.id)).toMatchObject({ status: "recovered", recovered_via: "external" });
  });

  it("doesn't credit a stale Unquit attempt", async () => {
    const t = setup();
    const c = t.db.addCase({ link_first_opened_at: T0.toISOString() });
    await t.db.repo.setPendingAttribution(c.id, "update_link", T0.toISOString());
    await recordRecovery(t.db.repo, "acc_1", { id: c.stripe_invoice_id, amountPaidCents: 4_900, paidAt: new Date(T0.getTime() + ATTRIBUTION_WINDOW_MS + 1) });
    expect(t.db.saves).toEqual([]);
  });

  it("is idempotent across the page and the webhook (and duplicate deliveries)", async () => {
    const t = setup();
    const c = t.db.addCase({ link_first_opened_at: T0.toISOString() });
    await t.db.repo.setPendingAttribution(c.id, "update_link", T0.toISOString());
    const paid = { id: c.stripe_invoice_id, amountPaidCents: 4_900, paidAt: new Date(T0.getTime() + 1000) };
    const [a, b] = await Promise.all([recordRecovery(t.db.repo, "acc_1", paid), recordRecovery(t.db.repo, "acc_1", paid)]);
    await recordRecovery(t.db.repo, "acc_1", paid);
    expect(t.db.saves).toHaveLength(1);
    expect(t.db.feeLines).toHaveLength(1);
    expect([a, b].filter((r) => r.recorded && r.won)).toHaveLength(1);
  });

  it("repairs a missing save when the webhook is retried after a crash", async () => {
    const t = setup();
    const c = t.db.addCase();
    await t.db.repo.markRecovered(c.id, { via: "update_link", amountCents: 4_900, at: T0.toISOString() }); // crashed before the save
    expect(t.db.saves).toHaveLength(0);
    await recordRecovery(t.db.repo, "acc_1", { id: c.stripe_invoice_id, amountPaidCents: 4_900, paidAt: T0 });
    expect(t.db.saves).toEqual([expect.objectContaining({ attributedVia: "update_link", feeCents: 490 })]);
  });

  it("ignores paid invoices that never failed", async () => {
    const t = setup();
    expect(await recordRecovery(t.db.repo, "acc_1", { id: "in_fine", amountPaidCents: 4_900, paidAt: T0 })).toEqual({
      recorded: false,
      reason: "no_case",
    });
  });

  it("applies the $299 monthly cap across a month of dunning fees", async () => {
    const t = setup();
    let earned = 0;
    let charged = 0;
    for (const amount of [150_000, 100_000, 90_000]) {
      const c = t.db.addCase({ amount_due_cents: amount, link_first_opened_at: T0.toISOString() });
      await t.db.repo.setPendingAttribution(c.id, "update_link", T0.toISOString());
      const r = await recordRecovery(t.db.repo, "acc_1", { id: c.stripe_invoice_id, amountPaidCents: amount, paidAt: T0 });
      if (!r.recorded) throw new Error("expected a recovery");
      const capped = applyMonthlyCap(r.attribution.feeCents, earned);
      earned += capped.earnedCents;
      charged += capped.chargedCents;
    }
    expect(t.db.saves.map((s) => s.feeCents)).toEqual([15_000, 10_000, 9_000]); // the save keeps its full 10%
    expect(earned).toBe(34_000);
    expect(charged).toBe(MONTHLY_FEE_CAP_CENTS); // the founder pays at most $299
  });
});
