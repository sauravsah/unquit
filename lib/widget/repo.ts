import "server-only";
import { attempt, insertStatement, queryOne, run, updateStatement, type Db } from "@/lib/db/core";
import { flowFromRow, type FlowRow } from "@/lib/flows/schema";
import { createLedgerRepo } from "@/lib/ledger/repo";
import { endSavesForSubscription, supersedePendingSaves } from "@/lib/saves/verify";
import type { SessionRow, WidgetRepo } from "./service";

const SESSION_COLUMNS =
  "id, account_id, stripe_customer_id, stripe_subscription_id, status, reason, offer_shown, offer_accepted, offer_accepted_at, offers_enabled, cancel_mode, started_at";

/**
 * Database side of the widget (its end customers have no session). Every
 * query is scoped by account_id, which the route resolved from the
 * publishable key + HMAC.
 */
export function createWidgetRepo(db: Db): WidgetRepo {
  return {
    async loadFlow(accountId) {
      const row = await attempt("Loading flow", () =>
        queryOne<FlowRow>(db, "select template, reasons, cancel_mode, offer_cooldown_days from flows where account_id = $1", [accountId]),
      );
      return flowFromRow(row);
    },

    async lastAcceptedAt(accountId, subscriptionId, excludeSessionId) {
      const params: unknown[] = [accountId, subscriptionId];
      let exclude = "";
      if (excludeSessionId) {
        params.push(excludeSessionId);
        exclude = "and id <> $3";
      }
      const row = await attempt("Loading offer history", () =>
        queryOne<{ offer_accepted_at: string | null }>(
          db,
          `select offer_accepted_at from cancel_sessions
            where account_id = $1 and stripe_subscription_id = $2 and offer_accepted ${exclude}
            order by offer_accepted_at desc nulls last
            limit 1`,
          params,
        ),
      );
      return row?.offer_accepted_at ?? null;
    },

    async createSession(input) {
      const rows = await attempt("Starting cancel session", () =>
        run<SessionRow>(
          db,
          insertStatement(
            "cancel_sessions",
            {
              account_id: input.accountId,
              stripe_customer_id: input.customerId,
              stripe_subscription_id: input.subscriptionId,
              mrr_at_start_cents: input.mrrAtStartCents,
              offers_enabled: input.offersEnabled,
              status: "started",
            },
            { returning: SESSION_COLUMNS },
          ),
        ),
      );
      const row = rows[0];
      if (!row) throw new Error("Starting cancel session failed: no row returned");
      return row;
    },

    async getSession(accountId, sessionId) {
      return attempt("Loading cancel session", () =>
        queryOne<SessionRow>(db, `select ${SESSION_COLUMNS} from cancel_sessions where account_id = $1 and id = $2`, [accountId, sessionId]),
      );
    },

    async markAccepted(sessionId, f) {
      const rows = await attempt("Recording accepted offer", () =>
        run(
          db,
          updateStatement(
            "cancel_sessions",
            {
              status: "offer_accepted",
              reason: f.reason,
              reason_label: f.reasonLabel,
              reason_detail: f.reasonDetail,
              offer_shown: f.offerShown,
              offer_accepted: true,
              offer_accepted_at: f.acceptedAt,
              completed_at: f.acceptedAt,
            },
            { id: sessionId, offer_accepted: false }, // compare-and-set
            { returning: "id", extraWhere: () => "status <> 'canceled'" },
          ),
        ),
      );
      return rows.length > 0;
    },

    async insertPendingSave(input) {
      // saves_cancel_session_id_key (unique) makes a second insert for the same session a no-op.
      await attempt("Recording pending save", () =>
        run(
          db,
          insertStatement(
            "saves",
            {
              account_id: input.accountId,
              type: "cancel",
              cancel_session_id: input.cancelSessionId,
              stripe_customer_id: input.customerId,
              stripe_subscription_id: input.subscriptionId,
              offer: input.offer,
              saved_mrr_cents: input.savedMrrCents,
              currency: input.currency,
              status: "pending",
              created_at: input.createdAt,
            },
            { onConflictDoNothing: "cancel_session_id" },
          ),
        ),
      );
    },

    async markCanceled(sessionId, f) {
      const rows = await attempt("Recording cancellation", () =>
        run(
          db,
          updateStatement(
            "cancel_sessions",
            {
              status: "canceled",
              reason: f.reason,
              reason_label: f.reasonLabel,
              reason_detail: f.reasonDetail,
              offer_shown: f.offerShown,
              cancel_mode: f.cancelMode,
              completed_at: f.completedAt,
            },
            { id: sessionId, offer_accepted: false },
            { returning: "id", extraWhere: () => "status <> 'canceled'" },
          ),
        ),
      );
      return rows.length > 0;
    },

    async supersedeEarlierSaves(input) {
      await supersedePendingSaves(createLedgerRepo(db), input.accountId, input.subscriptionId, input.keepSessionId, new Date(input.at));
    },

    async endSavesOnCancel(input) {
      await endSavesForSubscription(createLedgerRepo(db), input.accountId, input.subscriptionId, new Date(input.at), {
        keepSessionId: input.sessionId,
      });
    },
  };
}
