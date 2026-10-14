/**
 * In-memory fakes for the dunning tests. They keep the same guarantees as
 * the real database and Stripe:
 *   * one case per (account, invoice); one email per (case, step) with the
 *     same claim outcomes as dunning_claim_email()
 *   * advanceSequence / markRecovered are compare-and-set
 *   * one dunning save (and one fee line) per case
 *   * Stripe replays a request with a known idempotency key
 */
import type { EmailClient, EmailMessage, SendResult } from "@/lib/email";
import { EmailSendError } from "@/lib/email";
import type { DunningSettings } from "../settings";
import { settingsFromRow } from "../settings";
import type { LiveState } from "../schedule";
import type { CardUpdateStripe, LiveInvoice, PayOutcome, SetupIntentInfo } from "../card-update";
import type { DunningStripe } from "../service";
import type {
  CaseAccount,
  CaseWithAccount,
  ClaimOutcome,
  DunningCaseRow,
  DunningRepo,
  DunningSaveInput,
} from "../types";

let counter = 0;
export const uuid = () => `00000000-0000-4000-8000-${String(++counter).padStart(12, "0")}`;

export type FakeEmailRow = {
  id: string;
  caseId: string;
  step: number;
  status: "sending" | "sent" | "logged" | "failed";
  attempts: number;
  subject: string;
  to: string;
  claimedAt: number;
  providerMessageId?: string;
  error?: string;
};

export function fakeRepo(options: { settings?: Partial<DunningSettings>; accounts?: CaseAccount[]; clock?: () => Date } = {}) {
  const clock = options.clock ?? (() => new Date());
  const accounts = new Map<string, CaseAccount & { connected: boolean }>();
  for (const a of options.accounts ?? [{ id: "acc_1", name: "Acme", stripe_account_id: "acct_1" }]) {
    accounts.set(a.id, { ...a, connected: true });
  }
  const settings = new Map<string, DunningSettings>();
  const defaults: DunningSettings = { ...settingsFromRow(null), enabled: true, companyName: "Acme", ...options.settings };
  const cases = new Map<string, DunningCaseRow & Record<string, unknown>>();
  const emails: FakeEmailRow[] = [];
  const saves: DunningSaveInput[] = [];
  const feeLines: { caseId: string; amountCents: number; billingMonth: string }[] = [];

  const withAccount = (c: DunningCaseRow): CaseWithAccount => {
    const a = accounts.get(c.account_id)!;
    return { ...c, account: { id: a.id, name: a.name, stripe_account_id: a.stripe_account_id, ...(a.paused ? { paused: true } : {}) } };
  };

  const repo: DunningRepo = {
    async getSettings(accountId) {
      return settings.get(accountId) ?? defaults;
    },
    async findCaseByInvoice(accountId, invoiceId) {
      const c = [...cases.values()].find((x) => x.account_id === accountId && x.stripe_invoice_id === invoiceId);
      return c ? { ...c } : null;
    },
    async getCase(caseId) {
      const c = cases.get(caseId);
      return c ? withAccount({ ...c }) : null;
    },
    async insertCase(row) {
      if ([...cases.values()].some((x) => x.account_id === row.account_id && x.stripe_invoice_id === row.stripe_invoice_id)) return null;
      const c: DunningCaseRow & Record<string, unknown> = {
        id: uuid(),
        status: "open",
        sequence_step: 0,
        link_nonce: uuid(),
        link_first_opened_at: null,
        pending_attribution: null,
        pending_attribution_at: null,
        recovered_via: null,
        recovered_amount_cents: null,
        recovered_at: null,
        sequence_stop_reason: null,
        ...row,
      } as DunningCaseRow & Record<string, unknown>;
      cases.set(c.id, c);
      return { ...c };
    },
    async updateOpenCase(caseId, fields) {
      const c = cases.get(caseId);
      if (c && c.status === "open") Object.assign(c, fields);
    },
    async dueCases(now, limit) {
      return [...cases.values()]
        .filter((c) => {
          const a = accounts.get(c.account_id);
          const s = settings.get(c.account_id) ?? defaults;
          return (
            c.status === "open" && a?.connected && !a.paused && s.enabled && c.next_email_at !== null && Date.parse(c.next_email_at) <= now.getTime()
          );
        })
        .slice(0, limit)
        .map((c) => withAccount({ ...c }));
    },
    async claimEmail(input) {
      const existing = emails.find((e) => e.caseId === input.caseId && e.step === input.step);
      if (!existing) {
        const row: FakeEmailRow = {
          id: uuid(),
          caseId: input.caseId,
          step: input.step,
          status: "sending",
          attempts: 1,
          subject: input.subject,
          to: input.toEmail,
          claimedAt: clock().getTime(),
        };
        emails.push(row);
        return { emailId: row.id, outcome: "claimed" };
      }
      let outcome: ClaimOutcome;
      if (existing.status === "sent" || existing.status === "logged") outcome = "already_sent";
      else if (existing.status === "failed" && existing.attempts >= 3) outcome = "gave_up";
      else if (existing.status === "failed" || clock().getTime() - existing.claimedAt > 10 * 60_000) {
        existing.status = "sending";
        existing.attempts += 1;
        existing.claimedAt = clock().getTime();
        outcome = "claimed";
      } else outcome = "in_flight";
      return { emailId: existing.id, outcome };
    },
    async markEmailSent(emailId, f) {
      const e = emails.find((x) => x.id === emailId)!;
      e.status = f.status;
      e.providerMessageId = f.providerMessageId;
    },
    async markEmailFailed(emailId, error) {
      const e = emails.find((x) => x.id === emailId)!;
      e.status = "failed";
      e.error = error;
    },
    async advanceSequence(caseId, fromStep, nextEmailAt) {
      const c = cases.get(caseId);
      if (!c || c.status !== "open" || c.sequence_step !== fromStep) return false;
      c.sequence_step = fromStep + 1;
      c.next_email_at = nextEmailAt;
      return true;
    },
    async stopSequence(caseId, reason, at) {
      const c = cases.get(caseId);
      if (!c) return;
      Object.assign(c, { next_email_at: null, sequence_stop_reason: reason, sequence_stopped_at: at });
    },
    async closeCasesForSubscription(accountId, subscriptionId, at) {
      let n = 0;
      for (const c of cases.values()) {
        if (c.account_id === accountId && c.stripe_subscription_id === subscriptionId && c.status === "open") {
          Object.assign(c, { status: "closed", closed_at: at, next_email_at: null, sequence_stop_reason: "canceled" });
          n++;
        }
      }
      return n;
    },
    async setPendingAttribution(caseId, via, at) {
      const c = cases.get(caseId);
      if (c && c.status === "open") Object.assign(c, { pending_attribution: via, pending_attribution_at: at });
    },
    async clearPendingAttribution(caseId, at) {
      const c = cases.get(caseId);
      if (c && c.pending_attribution_at === at) Object.assign(c, { pending_attribution: null, pending_attribution_at: null });
    },
    async markLinkOpened(caseId, at) {
      const c = cases.get(caseId);
      if (c) c.link_first_opened_at = c.link_first_opened_at ?? at;
    },
    async markRecovered(caseId, f) {
      const c = cases.get(caseId);
      if (!c || c.status !== "open") return false;
      Object.assign(c, {
        status: "recovered",
        recovered_via: f.via,
        recovered_amount_cents: f.amountCents,
        recovered_at: f.at,
        link_nonce: uuid(),
        next_email_at: null,
        sequence_stop_reason: "paid",
        pending_attribution: null,
        pending_attribution_at: null,
      });
      return true;
    },
    async upsertDunningSave(input) {
      if (saves.some((s) => s.caseId === input.caseId)) return;
      saves.push(input);
      feeLines.push({ caseId: input.caseId, amountCents: input.feeCents, billingMonth: input.billingMonth });
    },
  };

  return {
    repo,
    cases,
    emails,
    saves,
    feeLines,
    settings,
    accounts,
    /** Puts a case straight into the store. */
    addCase(partial: Partial<DunningCaseRow> = {}): DunningCaseRow {
      const c = {
        id: uuid(),
        account_id: "acc_1",
        stripe_invoice_id: `in_${counter}`,
        stripe_customer_id: "cus_1",
        stripe_subscription_id: "sub_1",
        amount_due_cents: 4_900,
        currency: "usd",
        status: "open",
        decline_code: "expired_card",
        decline_category: "hard",
        customer_email: "jamie@example.com",
        customer_name: "Jamie Rivera",
        invoice_number: "ACME-0042",
        hosted_invoice_url: "https://invoice.stripe.com/i/acct_1/test",
        sequence_step: 0,
        next_email_at: clock().toISOString(),
        opened_at: clock().toISOString(),
        link_nonce: uuid(),
        link_first_opened_at: null,
        pending_attribution: null,
        pending_attribution_at: null,
        recovered_via: null,
        recovered_amount_cents: null,
        recovered_at: null,
        ...partial,
      } as DunningCaseRow;
      cases.set(c.id, { ...c } as DunningCaseRow & Record<string, unknown>);
      return c; // a snapshot: the stored row changes independently
    },
  };
}

export function fakeEmail(options: { live?: boolean } = {}) {
  const sent: EmailMessage[] = [];
  const byKey = new Map<string, SendResult>();
  let failures = 0;
  const client: EmailClient = {
    live: options.live ?? true,
    async send(message) {
      if (failures > 0) {
        failures--;
        throw new EmailSendError("Resend rejected the email (503): unavailable", 503, true);
      }
      // Resend's idempotency key: same key, same result, no second email.
      if (message.idempotencyKey && byKey.has(message.idempotencyKey)) return byKey.get(message.idempotencyKey)!;
      sent.push(message);
      const result: SendResult = client.live
        ? { id: `re_${sent.length}`, delivered: true }
        : { id: `logged_${sent.length}`, delivered: false, reason: "no_api_key" };
      if (message.idempotencyKey) byKey.set(message.idempotencyKey, result);
      return result;
    },
  };
  return { client, sent, failNext: (n = 1) => void (failures = n) };
}

export function fakeLiveStripe(initial: Partial<LiveState> = {}) {
  const state: LiveState & { throws: boolean } = { invoiceStatus: "open", subscriptionStatus: "past_due", throws: false, ...initial };
  const stripe: DunningStripe = {
    async getLiveState() {
      if (state.throws) throw new Error("Stripe is down");
      return { invoiceStatus: state.invoiceStatus, subscriptionStatus: state.subscriptionStatus };
    },
  };
  return { stripe, state };
}

/** A connected account's invoices, customers and SetupIntents. */
export function fakeCardStripe(options: { invoice: Omit<LiveInvoice, "status" | "amountPaidCents" | "paidAtUnix"> & Partial<LiveInvoice> }) {
  const invoice: LiveInvoice = { status: "open", amountPaidCents: 0, paidAtUnix: null, ...options.invoice };
  const setupIntents = new Map<string, SetupIntentInfo & { clientSecret: string }>();
  const defaults: { customerId: string; subscriptionId: string | null; paymentMethodId: string }[] = [];
  const payCalls: { paymentMethodId: string | null; idempotencyKey: string }[] = [];
  const replay = new Map<string, PayOutcome>();
  /** What the next charge does: succeed, decline, or ask for 3DS. */
  const behaviour = { next: "succeed" as "succeed" | "decline" | "requires_action", paidAtUnix: 0 };

  const stripe: CardUpdateStripe = {
    async getInvoice(_acct, id) {
      return id === invoice.id ? { ...invoice } : null;
    },
    async createSetupIntent(_acct, input) {
      const existing = [...setupIntents.values()].find((s) => s.clientSecret.endsWith(input.idempotencyKey));
      if (existing) return { id: existing.id, clientSecret: existing.clientSecret };
      const id = `seti_${setupIntents.size + 1}`;
      setupIntents.set(id, {
        id,
        status: "requires_payment_method",
        customerId: input.customerId,
        paymentMethodId: null,
        caseId: input.caseId,
        clientSecret: `${id}_secret_${input.idempotencyKey}`,
      });
      return { id, clientSecret: setupIntents.get(id)!.clientSecret };
    },
    async getSetupIntent(_acct, id) {
      const s = setupIntents.get(id);
      return s ? { id: s.id, status: s.status, customerId: s.customerId, paymentMethodId: s.paymentMethodId, caseId: s.caseId } : null;
    },
    async setDefaultPaymentMethod(_acct, input) {
      defaults.push({ customerId: input.customerId, subscriptionId: input.subscriptionId, paymentMethodId: input.paymentMethodId });
    },
    async payInvoice(_acct, id, input) {
      if (replay.has(input.idempotencyKey)) return replay.get(input.idempotencyKey)!;
      payCalls.push({ paymentMethodId: input.paymentMethodId, idempotencyKey: input.idempotencyKey });
      let outcome: PayOutcome;
      if (id !== invoice.id || invoice.status !== "open") {
        outcome = { status: "failed", message: "This invoice can't be paid.", declineCode: null };
      } else if (behaviour.next === "decline") {
        outcome = { status: "failed", message: "Your card was declined.", declineCode: "generic_decline" };
      } else if (behaviour.next === "requires_action") {
        outcome = { status: "requires_action", clientSecret: "pi_123_secret_abc" };
      } else {
        Object.assign(invoice, { status: "paid", amountPaidCents: invoice.amountRemainingCents, amountRemainingCents: 0, paidAtUnix: behaviour.paidAtUnix });
        outcome = { status: "paid", invoice: { ...invoice } };
      }
      replay.set(input.idempotencyKey, outcome);
      return outcome;
    },
  };

  return {
    stripe,
    invoice,
    setupIntents,
    defaults,
    payCalls,
    behaviour,
    /** What Stripe.js does when the customer submits the card (and passes 3DS). */
    confirmSetup(id: string, paymentMethodId = "pm_new") {
      Object.assign(setupIntents.get(id)!, { status: "succeeded", paymentMethodId });
    },
    /** The customer passed the 3DS challenge on the invoice payment. */
    completeAction() {
      Object.assign(invoice, { status: "paid", amountPaidCents: invoice.amountRemainingCents, amountRemainingCents: 0, paidAtUnix: behaviour.paidAtUnix });
    },
  };
}
