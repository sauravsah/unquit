import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
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

function fail(what: string, error: { message: string }): never {
  throw new Error(`${what} failed: ${error.message}`);
}

const UNIQUE_VIOLATION = "23505";

/**
 * The ledger's database side, using the SERVICE-ROLE client: webhooks, the
 * cron and server routes (after they checked who the founder is). Founders
 * can't write any of these tables from the browser (migration 0004).
 */
export function createLedgerRepo(admin: SupabaseClient): LedgerRepo {
  const one = async <T>(what: string, q: PromiseLike<{ data: unknown; error: { message: string } | null }>): Promise<T | null> => {
    const { data, error } = await q;
    if (error) fail(what, error);
    return (data as T | null) ?? null;
  };
  const many = async <T>(what: string, q: PromiseLike<{ data: unknown; error: { message: string } | null }>): Promise<T[]> => {
    const { data, error } = await q;
    if (error) fail(what, error);
    return (data as T[] | null) ?? [];
  };
  const changed = async (what: string, q: PromiseLike<{ data: unknown; error: { message: string } | null }>) =>
    (await many<{ id: string }>(what, q)).length > 0;

  return {
    async getAccount(accountId) {
      return one("Loading account", admin.from("accounts").select("id, name, stripe_account_id, owner_user_id").eq("id", accountId).maybeSingle());
    },

    async getSave(saveId) {
      return one<SaveRow>("Loading save", admin.from("saves").select(SAVE_COLUMNS).eq("id", saveId).maybeSingle());
    },

    async savesForSubscription(accountId, subscriptionId, statuses) {
      return many<SaveRow>(
        "Loading saves",
        admin
          .from("saves")
          .select(SAVE_COLUMNS)
          .eq("account_id", accountId)
          .eq("stripe_subscription_id", subscriptionId)
          .in("status", statuses)
          .order("created_at", { ascending: true }),
      );
    },

    async pendingSavesCreatedBefore(cutoffIso, limit) {
      return many<SaveRow>(
        "Loading pending saves",
        admin.from("saves").select(SAVE_COLUMNS).eq("status", "pending").lt("created_at", cutoffIso).order("created_at").limit(limit),
      );
    },

    async verifySave(saveId, f) {
      const patch: Record<string, unknown> = { status: "verified", verified_at: f.verifiedAt, stripe_invoice_id: f.invoiceId };
      if (f.customerEmail) patch.customer_email = f.customerEmail;
      return changed("Verifying save", admin.from("saves").update(patch).eq("id", saveId).eq("status", "pending").select("id"));
    },

    async markLost(saveId, reason, at) {
      return changed(
        "Marking save lost",
        admin.from("saves").update({ status: "lost", lost_reason: reason, lost_at: at }).eq("id", saveId).eq("status", "pending").select("id"),
      );
    },

    async markEnded(saveId, reason, at) {
      return changed(
        "Ending save",
        admin.from("saves").update({ ended_at: at, end_reason: reason }).eq("id", saveId).is("ended_at", null).select("id"),
      );
    },

    async setSaveStatus(saveId, from, to, extra = {}) {
      return changed("Updating save status", admin.from("saves").update({ status: to, ...extra }).eq("id", saveId).in("status", from).select("id"));
    },

    async setSaveFee(saveId, feeCents) {
      const { error } = await admin.from("saves").update({ fee_cents: feeCents }).eq("id", saveId);
      if (error) fail("Updating save fee", error);
    },

    async savesNeedingReceipt(sinceIso, limit, accountId) {
      let q = admin
        .from("saves")
        .select(SAVE_COLUMNS)
        .in("status", ["verified", "disputed"])
        .is("receipt_emailed_at", null)
        .gte("verified_at", sinceIso)
        .order("verified_at")
        .limit(limit);
      if (accountId) q = q.eq("account_id", accountId);
      return many<SaveRow>("Loading receipts to send", q);
    },

    async claimReceiptEmail(saveId, at) {
      return changed(
        "Claiming receipt email",
        admin.from("saves").update({ receipt_emailed_at: at }).eq("id", saveId).is("receipt_emailed_at", null).select("id"),
      );
    },

    async releaseReceiptEmail(saveId, at) {
      const { error } = await admin.from("saves").update({ receipt_emailed_at: null }).eq("id", saveId).eq("receipt_emailed_at", at);
      if (error) fail("Releasing receipt email", error);
    },

    async linesForSave(saveId) {
      return many<FeeLineRow>("Loading fee lines", admin.from("save_fee_lines").select(FEE_LINE_COLUMNS).eq("save_id", saveId).order("month_index"));
    },

    async linesForInvoice(accountId, invoiceId) {
      return many<FeeLineRow>(
        "Loading fee lines",
        admin.from("save_fee_lines").select(FEE_LINE_COLUMNS).eq("account_id", accountId).eq("stripe_invoice_id", invoiceId),
      );
    },

    async insertFeeLine(row) {
      const { data, error } = await admin.from("save_fee_lines").insert(row).select(FEE_LINE_COLUMNS);
      if (error) {
        if ((error as { code?: string }).code === UNIQUE_VIOLATION) return null; // (save, month) or (save, invoice) exists
        fail("Recording fee line", error);
      }
      return ((data ?? [])[0] as FeeLineRow | undefined) ?? null;
    },

    async casClawedBack(lineId, fromCents, toCents, fullyReversed) {
      const patch: Record<string, unknown> = { clawed_back_cents: toCents };
      if (fullyReversed) patch.status = "clawed_back";
      return changed(
        "Clawing back fee line",
        admin.from("save_fee_lines").update(patch).eq("id", lineId).eq("clawed_back_cents", fromCents).select("id"),
      );
    },

    async holdLinesForInvoice(accountId, invoiceId, stripeDisputeId) {
      return many<FeeLineRow>(
        "Holding fee lines",
        admin
          .from("save_fee_lines")
          .update({ held_stripe_dispute_id: stripeDisputeId })
          .eq("account_id", accountId)
          .eq("stripe_invoice_id", invoiceId)
          .select(FEE_LINE_COLUMNS),
      );
    },

    async releaseStripeHold(accountId, stripeDisputeId) {
      return many<FeeLineRow>(
        "Releasing fee lines",
        admin
          .from("save_fee_lines")
          .update({ held_stripe_dispute_id: null })
          .eq("account_id", accountId)
          .eq("held_stripe_dispute_id", stripeDisputeId)
          .select(FEE_LINE_COLUMNS),
      );
    },

    async setFounderHold(saveId, disputeId) {
      const { error } = await admin.from("save_fee_lines").update({ held_founder_dispute_id: disputeId }).eq("save_id", saveId);
      if (error) fail("Holding fee lines", error);
    },

    async upsertReversal(row) {
      const { error } = await admin.from("invoice_reversals").upsert(row, { onConflict: "account_id,source_key" });
      if (error) fail("Recording reversal", error);
    },

    async reversalsForInvoice(accountId, invoiceId) {
      return many<ReversalRow>(
        "Loading reversals",
        admin
          .from("invoice_reversals")
          .select("account_id, stripe_invoice_id, source_key, kind, amount_cents")
          .eq("account_id", accountId)
          .eq("stripe_invoice_id", invoiceId),
      );
    },

    async insertClawback(row) {
      const { error } = await admin.from("fee_clawbacks").insert(row);
      if (error) fail("Recording clawback", error);
    },

    async clawbacksForSave(saveId) {
      return many<ClawbackRow>(
        "Loading clawbacks",
        admin.from("fee_clawbacks").select("id, account_id, save_id, fee_line_id, kind, source, amount_cents, created_at").eq("save_id", saveId).order("created_at"),
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
      const { error } = e.dedupeKey
        ? await admin.from("save_events").upsert(row, { onConflict: "dedupe_key", ignoreDuplicates: true })
        : await admin.from("save_events").insert(row);
      if (error) fail("Recording save event", error);
    },

    async openDisputeForSave(saveId) {
      return one<DisputeRow>("Loading dispute", admin.from("disputes").select(DISPUTE_COLUMNS).eq("save_id", saveId).eq("status", "open").maybeSingle());
    },

    async insertDispute(row) {
      const { data, error } = await admin.from("disputes").insert({ ...row, status: "open" }).select(DISPUTE_COLUMNS);
      if (error) {
        if ((error as { code?: string }).code === UNIQUE_VIOLATION) return null; // disputes_one_open_per_save
        fail("Opening dispute", error);
      }
      return ((data ?? [])[0] as DisputeRow | undefined) ?? null;
    },

    async getDispute(disputeId) {
      return one<DisputeRow>("Loading dispute", admin.from("disputes").select(DISPUTE_COLUMNS).eq("id", disputeId).maybeSingle());
    },

    async setDisputeEvidence(disputeId, evidence) {
      const { error } = await admin.from("disputes").update({ evidence }).eq("id", disputeId);
      if (error) fail("Saving dispute evidence", error);
    },

    async resolveDispute(disputeId, f) {
      return changed(
        "Resolving dispute",
        admin
          .from("disputes")
          .update({ status: f.status, resolution: f.resolution, resolution_note: f.note, resolved_by: f.resolvedBy, resolved_at: f.at })
          .eq("id", disputeId)
          .eq("status", "open")
          .select("id"),
      );
    },

    async markDisputeNotified(disputeId, at) {
      const { error } = await admin.from("disputes").update({ founder_notified_at: at }).eq("id", disputeId);
      if (error) fail("Marking dispute notified", error);
    },

    async abandonSessionsStartedBefore(cutoffIso) {
      const rows = await many<{ id: string }>(
        "Abandoning cancel sessions",
        admin.from("cancel_sessions").update({ status: "abandoned" }).eq("status", "started").lt("started_at", cutoffIso).select("id"),
      );
      return rows.length;
    },
  };
}
