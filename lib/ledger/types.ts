/**
 * The save ledger's rows and the small database interface the ledger code
 * talks to. Like lib/dunning, the logic lives in plain functions that take a
 * repo, so it runs against Postgres in production (lib/ledger/repo.ts) and
 * against in-memory fakes in tests (lib/ledger/testing/fakes.ts).
 */

export type SaveType = "cancel" | "dunning";
export type SaveStatus = "pending" | "verified" | "disputed" | "clawed_back" | "lost";
export type LostReason = "expired" | "superseded" | "customer_canceled";
export type EndReason = "customer_canceled" | "superseded";

export type SaveRow = {
  id: string;
  account_id: string;
  type: SaveType;
  status: SaveStatus;
  cancel_session_id: string | null;
  dunning_case_id: string | null;
  stripe_customer_id: string;
  stripe_subscription_id: string | null;
  stripe_invoice_id: string | null;
  customer_email: string | null;
  offer: Record<string, unknown> | null;
  saved_mrr_cents: number;
  recovered_amount_cents: number;
  currency: string;
  fee_cents: number;
  attributed_via: "update_link" | "unquit_retry" | null;
  verified_at: string | null;
  clawed_back_at: string | null;
  lost_at: string | null;
  lost_reason: LostReason | null;
  ended_at: string | null;
  end_reason: EndReason | null;
  receipt_number: string;
  receipt_emailed_at: string | null;
  created_at: string;
};

export const SAVE_COLUMNS =
  "id, account_id, type, status, cancel_session_id, dunning_case_id, stripe_customer_id, stripe_subscription_id, stripe_invoice_id, customer_email, offer, saved_mrr_cents, recovered_amount_cents, currency, fee_cents, attributed_via, verified_at, clawed_back_at, lost_at, lost_reason, ended_at, end_reason, receipt_number, receipt_emailed_at, created_at";

export type FeeLineStatus = "earned" | "billed" | "clawed_back";

export type FeeLineRow = {
  id: string;
  save_id: string;
  account_id: string;
  month_index: number;
  billing_month: string; // YYYY-MM-01
  stripe_invoice_id: string | null;
  amount_cents: number;
  invoice_amount_paid_cents: number | null;
  clawed_back_cents: number;
  status: FeeLineStatus;
  held_stripe_dispute_id: string | null;
  held_founder_dispute_id: string | null;
  billing_period_id: string | null;
  billed_at: string | null;
  created_at: string;
};

export const FEE_LINE_COLUMNS =
  "id, save_id, account_id, month_index, billing_month, stripe_invoice_id, amount_cents, invoice_amount_paid_cents, clawed_back_cents, status, held_stripe_dispute_id, held_founder_dispute_id, billing_period_id, billed_at, created_at";

export type ReversalKind = "refund" | "credit_note" | "dispute_lost";
export type ClawbackKind = ReversalKind | "dispute_accepted" | "dispute_auto";

export type ReversalRow = {
  account_id: string;
  stripe_invoice_id: string;
  source_key: string;
  kind: ReversalKind;
  amount_cents: number;
};

export type ClawbackRow = {
  id: string;
  account_id: string;
  save_id: string;
  fee_line_id: string;
  kind: ClawbackKind;
  source: string | null;
  amount_cents: number;
  created_at: string;
};

export type SaveEventKind =
  | "offer_accepted"
  | "invoice_paid"
  | "verified"
  | "fee_line"
  | "recovered"
  | "lost"
  | "ended"
  | "refund"
  | "credit_note"
  | "stripe_dispute_opened"
  | "stripe_dispute_won"
  | "stripe_dispute_lost"
  | "dispute_opened"
  | "dispute_accepted"
  | "dispute_rejected"
  | "billed";

export type SaveEventInput = {
  accountId: string;
  saveId: string;
  kind: SaveEventKind;
  detail?: Record<string, unknown>;
  /** Same key twice = one timeline line (re-delivered webhooks). */
  dedupeKey?: string;
  occurredAt: string;
};

export type SaveEventRow = {
  id: string;
  save_id: string;
  kind: SaveEventKind;
  detail: Record<string, unknown>;
  occurred_at: string;
};

export type DisputeCategory = "would_have_stayed" | "wrong_customer" | "refunded" | "other";
export type DisputeStatus = "open" | "accepted" | "rejected";

export type DisputeRow = {
  id: string;
  save_id: string;
  account_id: string;
  opened_by: string | null;
  reason: string;
  category: DisputeCategory;
  note: string | null;
  status: DisputeStatus;
  resolution: "auto" | "admin" | null;
  resolution_note: string | null;
  resolved_by: string | null;
  evidence: Record<string, unknown> | null;
  created_at: string;
  resolved_at: string | null;
  founder_notified_at: string | null;
};

export const DISPUTE_COLUMNS =
  "id, save_id, account_id, opened_by, reason, category, note, status, resolution, resolution_note, resolved_by, evidence, created_at, resolved_at, founder_notified_at";

export type LedgerAccount = {
  id: string;
  name: string | null;
  stripe_account_id: string | null;
  owner_user_id: string;
};

export interface LedgerRepo {
  getAccount(accountId: string): Promise<LedgerAccount | null>;

  // --- saves ---------------------------------------------------------------
  getSave(saveId: string): Promise<SaveRow | null>;
  /** Saves on one subscription in any of these statuses. */
  savesForSubscription(accountId: string, subscriptionId: string, statuses: SaveStatus[]): Promise<SaveRow[]>;
  /** Pending saves (any account) created before `cutoffIso`: candidates for expiry. */
  pendingSavesCreatedBefore(cutoffIso: string, limit: number): Promise<SaveRow[]>;
  /** Compare-and-set pending -> verified. True if this call won. */
  verifySave(saveId: string, f: { verifiedAt: string; invoiceId: string; customerEmail: string | null }): Promise<boolean>;
  /** Compare-and-set pending -> lost. */
  markLost(saveId: string, reason: LostReason, at: string): Promise<boolean>;
  /** Compare-and-set ended_at null -> set. Fee accrual stops; status unchanged. */
  markEnded(saveId: string, reason: EndReason, at: string): Promise<boolean>;
  /** Compare-and-set status in `from` -> `to`. */
  setSaveStatus(saveId: string, from: SaveStatus[], to: SaveStatus, extra?: { clawed_back_at?: string | null }): Promise<boolean>;
  /** saves.fee_cents = what the save has earned, net of clawbacks (before the cap). */
  setSaveFee(saveId: string, feeCents: number): Promise<void>;
  /** Verified saves whose receipt email hasn't gone out, verified after `sinceIso`. */
  savesNeedingReceipt(sinceIso: string, limit: number, accountId?: string): Promise<SaveRow[]>;
  /** Compare-and-set receipt_emailed_at null -> at. */
  claimReceiptEmail(saveId: string, at: string): Promise<boolean>;
  /** Clears the claim when the send failed, so the next run retries. */
  releaseReceiptEmail(saveId: string, at: string): Promise<void>;

  // --- fee lines -------------------------------------------------------------
  linesForSave(saveId: string): Promise<FeeLineRow[]>;
  linesForInvoice(accountId: string, invoiceId: string): Promise<FeeLineRow[]>;
  /** Unique per (save, month) and (save, invoice): null when it already exists. */
  insertFeeLine(row: Omit<FeeLineRow, "id" | "created_at" | "clawed_back_cents" | "status" | "held_stripe_dispute_id" | "billing_period_id" | "billed_at">): Promise<FeeLineRow | null>;
  /** Compare-and-set clawed_back_cents from -> to. */
  casClawedBack(lineId: string, fromCents: number, toCents: number, fullyReversed: boolean): Promise<boolean>;
  holdLinesForInvoice(accountId: string, invoiceId: string, stripeDisputeId: string): Promise<FeeLineRow[]>;
  releaseStripeHold(accountId: string, stripeDisputeId: string): Promise<FeeLineRow[]>;
  setFounderHold(saveId: string, disputeId: string | null): Promise<void>;

  // --- reversals / clawbacks / events -----------------------------------------
  /** Upsert by (account, source_key): the source's cumulative amount. */
  upsertReversal(row: ReversalRow): Promise<void>;
  reversalsForInvoice(accountId: string, invoiceId: string): Promise<ReversalRow[]>;
  insertClawback(row: Omit<ClawbackRow, "id" | "created_at">): Promise<void>;
  clawbacksForSave(saveId: string): Promise<ClawbackRow[]>;
  addEvent(event: SaveEventInput): Promise<void>;

  // --- disputes ----------------------------------------------------------------
  openDisputeForSave(saveId: string): Promise<DisputeRow | null>;
  /** null when the save already has an open dispute (unique index). */
  insertDispute(row: {
    save_id: string;
    account_id: string;
    opened_by: string | null;
    reason: string;
    category: DisputeCategory;
    note: string | null;
    created_at: string;
  }): Promise<DisputeRow | null>;
  getDispute(disputeId: string): Promise<DisputeRow | null>;
  setDisputeEvidence(disputeId: string, evidence: Record<string, unknown>): Promise<void>;
  /** Compare-and-set open -> accepted/rejected. */
  resolveDispute(
    disputeId: string,
    f: { status: "accepted" | "rejected"; resolution: "auto" | "admin"; note: string | null; resolvedBy: string | null; at: string },
  ): Promise<boolean>;
  markDisputeNotified(disputeId: string, at: string): Promise<void>;

  // --- cancel sessions ------------------------------------------------------------
  /** started -> abandoned for sessions started before the cutoff. Returns how many. */
  abandonSessionsStartedBefore(cutoffIso: string): Promise<number>;
}
