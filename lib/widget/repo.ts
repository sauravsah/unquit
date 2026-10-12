import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { flowFromRow, type FlowRow } from "@/lib/flows/schema";
import type { SessionRow, WidgetRepo } from "./service";

const SESSION_COLUMNS =
  "id, account_id, stripe_customer_id, stripe_subscription_id, status, reason, offer_shown, offer_accepted, offer_accepted_at, offers_enabled, cancel_mode, started_at";

/**
 * Database side of the widget, using the SERVICE-ROLE client (the widget's
 * end customers have no Supabase session). Every query is scoped by
 * account_id, which the route resolved from the publishable key.
 */
export function createWidgetRepo(admin: SupabaseClient): WidgetRepo {
  return {
    async loadFlow(accountId) {
      const { data, error } = await admin
        .from("flows")
        .select("template, reasons, cancel_mode, offer_cooldown_days")
        .eq("account_id", accountId)
        .maybeSingle();
      if (error) throw new Error(`Loading flow failed: ${error.message}`);
      return flowFromRow(data as FlowRow | null);
    },

    async lastAcceptedAt(accountId, subscriptionId, excludeSessionId) {
      let query = admin
        .from("cancel_sessions")
        .select("offer_accepted_at")
        .eq("account_id", accountId)
        .eq("stripe_subscription_id", subscriptionId)
        .eq("offer_accepted", true)
        .order("offer_accepted_at", { ascending: false })
        .limit(1);
      if (excludeSessionId) query = query.neq("id", excludeSessionId);
      const { data, error } = await query;
      if (error) throw new Error(`Loading offer history failed: ${error.message}`);
      return (data?.[0]?.offer_accepted_at as string | undefined) ?? null;
    },

    async createSession(input) {
      const { data, error } = await admin
        .from("cancel_sessions")
        .insert({
          account_id: input.accountId,
          stripe_customer_id: input.customerId,
          stripe_subscription_id: input.subscriptionId,
          mrr_at_start_cents: input.mrrAtStartCents,
          offers_enabled: input.offersEnabled,
          status: "started",
        })
        .select(SESSION_COLUMNS)
        .single();
      if (error) throw new Error(`Starting cancel session failed: ${error.message}`);
      return data as SessionRow;
    },

    async getSession(accountId, sessionId) {
      const { data, error } = await admin
        .from("cancel_sessions")
        .select(SESSION_COLUMNS)
        .eq("account_id", accountId)
        .eq("id", sessionId)
        .maybeSingle();
      if (error) throw new Error(`Loading cancel session failed: ${error.message}`);
      return data as SessionRow | null;
    },

    async markAccepted(sessionId, f) {
      const { data, error } = await admin
        .from("cancel_sessions")
        .update({
          status: "offer_accepted",
          reason: f.reason,
          reason_label: f.reasonLabel,
          reason_detail: f.reasonDetail,
          offer_shown: f.offerShown,
          offer_accepted: true,
          offer_accepted_at: f.acceptedAt,
          completed_at: f.acceptedAt,
        })
        .eq("id", sessionId)
        .eq("offer_accepted", false) // compare-and-set
        .neq("status", "canceled")
        .select("id");
      if (error) throw new Error(`Recording accepted offer failed: ${error.message}`);
      return (data?.length ?? 0) > 0;
    },

    async insertPendingSave(input) {
      // saves_cancel_session_key (unique) makes a second insert for the same session a no-op.
      const { error } = await admin.from("saves").upsert(
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
        { onConflict: "cancel_session_id", ignoreDuplicates: true },
      );
      if (error) throw new Error(`Recording pending save failed: ${error.message}`);
    },

    async markCanceled(sessionId, f) {
      const { data, error } = await admin
        .from("cancel_sessions")
        .update({
          status: "canceled",
          reason: f.reason,
          reason_label: f.reasonLabel,
          reason_detail: f.reasonDetail,
          offer_shown: f.offerShown,
          cancel_mode: f.cancelMode,
          completed_at: f.completedAt,
        })
        .eq("id", sessionId)
        .eq("offer_accepted", false)
        .neq("status", "canceled")
        .select("id");
      if (error) throw new Error(`Recording cancellation failed: ${error.message}`);
      return (data?.length ?? 0) > 0;
    },
  };
}
