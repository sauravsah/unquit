import type { AttributedVia, RecoveredVia } from "./attribution";
import type { DeclineCategory } from "./declines";
import type { StopReason } from "./schedule";
import type { DunningSettings } from "./settings";

export type CaseStatus = "open" | "recovered" | "failed" | "closed";

/** The dunning_cases columns the dunning code reads. */
export type DunningCaseRow = {
  id: string;
  account_id: string;
  stripe_invoice_id: string;
  stripe_customer_id: string;
  stripe_subscription_id: string | null;
  amount_due_cents: number;
  currency: string;
  status: CaseStatus;
  decline_code: string | null;
  decline_category: DeclineCategory | null;
  customer_email: string | null;
  customer_name: string | null;
  invoice_number: string | null;
  hosted_invoice_url: string | null;
  sequence_step: number;
  next_email_at: string | null;
  opened_at: string;
  link_nonce: string;
  link_first_opened_at: string | null;
  pending_attribution: AttributedVia | null;
  pending_attribution_at: string | null;
  recovered_via: RecoveredVia | null;
  recovered_amount_cents: number | null;
  recovered_at: string | null;
};

export const CASE_COLUMNS =
  "id, account_id, stripe_invoice_id, stripe_customer_id, stripe_subscription_id, amount_due_cents, currency, status, decline_code, decline_category, customer_email, customer_name, invoice_number, hosted_invoice_url, sequence_step, next_email_at, opened_at, link_nonce, link_first_opened_at, pending_attribution, pending_attribution_at, recovered_via, recovered_amount_cents, recovered_at";

/** The founder account a case belongs to. */
export type CaseAccount = {
  id: string;
  name: string | null;
  stripe_account_id: string;
};

export type CaseWithAccount = DunningCaseRow & { account: CaseAccount };

/** What `invoice.payment_failed` tells us, already flattened from Stripe's shapes. */
export type FailedInvoice = {
  id: string;
  customerId: string;
  subscriptionId: string | null;
  amountDueCents: number;
  currency: string;
  attemptCount: number;
  nextPaymentAttemptAt: string | null;
  hostedInvoiceUrl: string | null;
  customerEmail: string | null;
  customerName: string | null;
  number: string | null;
  declineCode: string | null;
  errorCode: string | null;
  failureMessage: string | null;
  paymentIntentId: string | null;
};

export type PaidInvoiceInfo = {
  id: string;
  amountPaidCents: number;
  /** invoice.status_transitions.paid_at, or the event time. */
  paidAt: Date;
};

export type ClaimOutcome = "claimed" | "already_sent" | "in_flight" | "gave_up";

export type NewCase = {
  account_id: string;
  stripe_invoice_id: string;
  stripe_customer_id: string;
  stripe_subscription_id: string | null;
  amount_due_cents: number;
  currency: string;
  attempt_count: number;
  next_payment_attempt_at: string | null;
  hosted_invoice_url: string | null;
  customer_email: string | null;
  customer_name: string | null;
  invoice_number: string | null;
  decline_code: string | null;
  decline_category: DeclineCategory;
  last_failure_code: string | null;
  last_failure_message: string | null;
  stripe_payment_intent_id: string | null;
  opened_at: string;
  next_email_at: string | null;
};

export type CaseUpdate = Partial<Omit<NewCase, "account_id" | "stripe_invoice_id" | "opened_at" | "next_email_at">>;

export type DunningSaveInput = {
  accountId: string;
  caseId: string;
  customerId: string;
  subscriptionId: string | null;
  invoiceId: string;
  recoveredAmountCents: number;
  currency: string;
  feeCents: number;
  attributedVia: AttributedVia;
  verifiedAt: string;
  billingMonth: string; // YYYY-MM-01
};

/**
 * Database side of dunning. The real one (repo.ts) uses the service-role
 * Supabase client; tests use an in-memory fake with the same guarantees
 * (unique email per case+step, compare-and-set updates).
 */
export interface DunningRepo {
  getSettings(accountId: string): Promise<DunningSettings>;
  findCaseByInvoice(accountId: string, invoiceId: string): Promise<DunningCaseRow | null>;
  getCase(caseId: string): Promise<CaseWithAccount | null>;
  /** Inserts a case; returns null if one already exists for that invoice. */
  insertCase(row: NewCase): Promise<DunningCaseRow | null>;
  /** Updates an OPEN case only. */
  updateOpenCase(caseId: string, fields: CaseUpdate): Promise<void>;
  /** Open cases whose next email is due, on connected accounts with dunning switched on. */
  dueCases(now: Date, limit: number): Promise<CaseWithAccount[]>;
  claimEmail(input: {
    accountId: string;
    caseId: string;
    step: number;
    category: DeclineCategory;
    toEmail: string;
    subject: string;
  }): Promise<{ emailId: string; outcome: ClaimOutcome }>;
  markEmailSent(emailId: string, f: { status: "sent" | "logged"; providerMessageId: string; sentAt: string }): Promise<void>;
  markEmailFailed(emailId: string, error: string): Promise<void>;
  /** Compare-and-set on sequence_step: moves from `fromStep` to `fromStep + 1`. */
  advanceSequence(caseId: string, fromStep: number, nextEmailAt: string | null, at: string): Promise<boolean>;
  stopSequence(caseId: string, reason: StopReason, at: string): Promise<void>;
  /** Closes every OPEN case on a subscription (it was cancelled). Returns how many. */
  closeCasesForSubscription(accountId: string, subscriptionId: string, at: string): Promise<number>;
  setPendingAttribution(caseId: string, via: "update_link" | "unquit_retry", at: string): Promise<void>;
  /** Clears the mark only if it is still the one set at `at`. */
  clearPendingAttribution(caseId: string, at: string): Promise<void>;
  markLinkOpened(caseId: string, at: string): Promise<void>;
  /**
   * Compare-and-set open -> recovered. Rotates the link nonce (every link
   * dies), stops the sequence ('paid') and clears the pending mark.
   */
  markRecovered(caseId: string, f: { via: RecoveredVia; amountCents: number; at: string }): Promise<boolean>;
  /** Idempotent: one save (and one fee line) per dunning case. */
  upsertDunningSave(input: DunningSaveInput): Promise<void>;
}
