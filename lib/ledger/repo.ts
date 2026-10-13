import "server-only";
import { attempt, insertStatement, isUniqueViolation, queryOne, run, updateStatement, type Db } from "@/lib/db/core";
import {
  DISPUTE_COLUMNS,
  FEE_LINE_COLUMNS,
  SAVE_COLUMNS,
  type ClawbackRow,
  type DisputeRow,
  type FeeLineRow,
  type LedgerRepo,
  type ReversalRow,
  type SaveRow,
} from "./types";

const CLAWBACK_COLUMNS = "id, account_id, save_id, fee_line_id, kind, source, amount_cents, created_at";

/**
 * The ledger's database side: webhooks, the cron and server routes (after
 * they checked who the founder is). Only server code writes these tables.
 * Every write that can race is a compare-and-set (`... where status = $x
 * returning id`) or goes through a unique constraint.
 */
export function createLedgerRepo(db: Db): LedgerRepo {
  const changed = async (what: string, text: string, params: unknown[]) =>
    (await attempt(what, () => db.query<{ id: string }>(text, params))).length > 0;
  const changedBy = async (what: string, s: { text: string; params: unknown[] }) => changed(what, s.text, s.params);
  const exec = async (what: string, s: { text: string; params: unknown[] }) => {
    await attempt(what, () => run(db, s));
  };

  return {
    async getAccount(accountId) {
      return attempt("Loading account", () =>
        queryOne(db, "select id, name, stripe_account_id, owner_user_id from accounts where id = $1", [accountId]),
      );
    },

    async getSave(saveId) {
      return attempt("Loading save", () => queryOne<SaveRow>(db, `select ${SAVE_COLUMNS} from saves where id = $1`, [saveId]));
    },

    async savesForSubscription(accountId, subscriptionId, statuses) {
      return attempt("Loading saves", () =>
        db.query<SaveRow>(
          `select ${SAVE_COLUMNS} from saves
            where account_id = $1 and stripe_subscription_id = $2 and status = any($3)
            order by created_at asc`,
          [accountId, subscriptionId, statuses],
        ),
      );
    },

    async pendingSavesCreatedBefore(cutoffIso, limit) {
      return attempt("Loading pending saves", () =>
        db.query<SaveRow>(
          `select ${SAVE_COLUMNS} from saves where status = 'pending' and created_at < $1 order by created_at asc limit $2`,
          [cutoffIso, limit],
        ),
      );
    },

    async verifySave(saveId, f) {
      const patch: Record<string, unknown> = { status: "verified", verified_at: f.verifiedAt, stripe_invoice_id: f.invoiceId };
      if (f.customerEmail) patch.customer_email = f.customerEmail;
      return changedBy("Verifying save", updateStatement("saves", patch, { id: saveId, status: "pending" }, { returning: "id" }));
    },

    async markLost(saveId, reason, at) {
      return changedBy(
        "Marking save lost",
        updateStatement("saves", { status: "lost", lost_reason: reason, lost_at: at }, { id: saveId, status: "pending" }, { returning: "id" }),
      );
    },

    async markEnded(saveId, reason, at) {
      return changedBy(
        "Ending save",
        updateStatement("saves", { ended_at: at, end_reason: reason }, { id: saveId, ended_at: null }, { returning: "id" }),
      );
    },

    async setSaveStatus(saveId, from, to, extra = {}) {
      return changedBy(
        "Updating save status",
        updateStatement("saves", { status: to, ...extra }, { id: saveId, status: from }, { returning: "id" }),
      );
    },

    async setSaveFee(saveId, feeCents) {
      await exec("Updating save fee", updateStatement("saves", { fee_cents: feeCents }, { id: saveId }));
    },

    async savesNeedingReceipt(sinceIso, limit, accountId) {
      const params: unknown[] = [sinceIso, limit];
      let scope = "";
      if (accountId) {
        params.push(accountId);
        scope = "and account_id = $3";
      }
      return attempt("Loading receipts to send", () =>
        db.query<SaveRow>(
          `select ${SAVE_COLUMNS} from saves
            where status in ('verified', 'disputed') and receipt_emailed_at is null and verified_at >= $1 ${scope}
            order by verified_at asc limit $2`,
          params,
        ),
      );
    },

    async claimReceiptEmail(saveId, at) {
      return changedBy(
        "Claiming receipt email",
        updateStatement("saves", { receipt_emailed_at: at }, { id: saveId, receipt_emailed_at: null }, { returning: "id" }),
      );
    },

    async releaseReceiptEmail(saveId, at) {
      await attempt("Releasing receipt email", () =>
        db.query("update saves set receipt_emailed_at = null where id = $1 and receipt_emailed_at = $2", [saveId, at]),
      );
    },

    async linesForSave(saveId) {
      return attempt("Loading fee lines", () =>
        db.query<FeeLineRow>(`select ${FEE_LINE_COLUMNS} from save_fee_lines where save_id = $1 order by month_index asc`, [saveId]),
      );
    },

    async linesForInvoice(accountId, invoiceId) {
      return attempt("Loading fee lines", () =>
        db.query<FeeLineRow>(`select ${FEE_LINE_COLUMNS} from save_fee_lines where account_id = $1 and stripe_invoice_id = $2`, [
          accountId,
          invoiceId,
        ]),
      );
    },

    async insertFeeLine(row) {
      try {
        const rows = await run<FeeLineRow>(db, insertStatement("save_fee_lines", row, { returning: FEE_LINE_COLUMNS }));
        return rows[0] ?? null;
      } catch (error) {
        if (isUniqueViolation(error)) return null; // (save, month) or (save, invoice) exists
        return attempt("Recording fee line", () => Promise.reject(error));
      }
    },

    async casClawedBack(lineId, fromCents, toCents, fullyReversed) {
      const patch: Record<string, unknown> = { clawed_back_cents: toCents };
      if (fullyReversed) patch.status = "clawed_back";
      return changedBy(
        "Clawing back fee line",
        updateStatement("save_fee_lines", patch, { id: lineId, clawed_back_cents: fromCents }, { returning: "id" }),
      );
    },

    async holdLinesForInvoice(accountId, invoiceId, stripeDisputeId) {
      return attempt("Holding fee lines", () =>
        run<FeeLineRow>(
          db,
          updateStatement(
            "save_fee_lines",
            { held_stripe_dispute_id: stripeDisputeId },
            { account_id: accountId, stripe_invoice_id: invoiceId },
            { returning: FEE_LINE_COLUMNS },
          ),
        ),
      );
    },

    async releaseStripeHold(accountId, stripeDisputeId) {
      return attempt("Releasing fee lines", () =>
        run<FeeLineRow>(
          db,
          updateStatement(
            "save_fee_lines",
            { held_stripe_dispute_id: null },
            { account_id: accountId, held_stripe_dispute_id: stripeDisputeId },
            { returning: FEE_LINE_COLUMNS },
          ),
        ),
      );
    },

    async setFounderHold(saveId, disputeId) {
      await exec("Holding fee lines", updateStatement("save_fee_lines", { held_founder_dispute_id: disputeId }, { save_id: saveId }));
    },

    async upsertReversal(row) {
      await attempt("Recording reversal", () =>
        db.query(
          `insert into invoice_reversals (account_id, stripe_invoice_id, source_key, kind, amount_cents)
           values ($1, $2, $3, $4, $5)
           on conflict (account_id, source_key) do update set
             stripe_invoice_id = excluded.stripe_invoice_id,
             kind = excluded.kind,
             amount_cents = excluded.amount_cents`,
          [row.account_id, row.stripe_invoice_id, row.source_key, row.kind, row.amount_cents],
        ),
      );
    },

    async reversalsForInvoice(accountId, invoiceId) {
      return attempt("Loading reversals", () =>
        db.query<ReversalRow>(
          `select account_id, stripe_invoice_id, source_key, kind, amount_cents from invoice_reversals
            where account_id = $1 and stripe_invoice_id = $2`,
          [accountId, invoiceId],
        ),
      );
    },

    async insertClawback(row) {
      await exec("Recording clawback", insertStatement("fee_clawbacks", row));
    },

    async clawbacksForSave(saveId) {
      return attempt("Loading clawbacks", () =>
        db.query<ClawbackRow>(`select ${CLAWBACK_COLUMNS} from fee_clawbacks where save_id = $1 order by created_at asc`, [saveId]),
      );
    },

    async addEvent(e) {
      const row = {
        account_id: e.accountId,
        save_id: e.saveId,
        kind: e.kind,
        detail: e.detail ?? {},
        dedupe_key: e.dedupeKey ?? null,
        occurred_at: e.occurredAt,
      };
      await exec("Recording save event", insertStatement("save_events", row, e.dedupeKey ? { onConflictDoNothing: "dedupe_key" } : {}));
    },

    async openDisputeForSave(saveId) {
      return attempt("Loading dispute", () =>
        queryOne<DisputeRow>(db, `select ${DISPUTE_COLUMNS} from disputes where save_id = $1 and status = 'open'`, [saveId]),
      );
    },

    async insertDispute(row) {
      try {
        const rows = await run<DisputeRow>(db, insertStatement("disputes", { ...row, status: "open" }, { returning: DISPUTE_COLUMNS }));
        return rows[0] ?? null;
      } catch (error) {
        if (isUniqueViolation(error)) return null; // disputes_one_open_per_save
        return attempt("Opening dispute", () => Promise.reject(error));
      }
    },

    async getDispute(disputeId) {
      return attempt("Loading dispute", () => queryOne<DisputeRow>(db, `select ${DISPUTE_COLUMNS} from disputes where id = $1`, [disputeId]));
    },

    async setDisputeEvidence(disputeId, evidence) {
      await exec("Saving dispute evidence", updateStatement("disputes", { evidence }, { id: disputeId }));
    },

    async resolveDispute(disputeId, f) {
      return changedBy(
        "Resolving dispute",
        updateStatement(
          "disputes",
          { status: f.status, resolution: f.resolution, resolution_note: f.note, resolved_by: f.resolvedBy, resolved_at: f.at },
          { id: disputeId, status: "open" },
          { returning: "id" },
        ),
      );
    },

    async markDisputeNotified(disputeId, at) {
      await exec("Marking dispute notified", updateStatement("disputes", { founder_notified_at: at }, { id: disputeId }));
    },

    async abandonSessionsStartedBefore(cutoffIso) {
      const rows = await attempt("Abandoning cancel sessions", () =>
        db.query<{ id: string }>(
          "update cancel_sessions set status = 'abandoned' where status = 'started' and started_at < $1 returning id",
          [cutoffIso],
        ),
      );
      return rows.length;
    },
  };
}
