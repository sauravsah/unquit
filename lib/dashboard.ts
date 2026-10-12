import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { loadLedger, loadRunningTotal, type LedgerFilters, type LedgerItem, type RunningTotal } from "@/lib/ledger/dashboard";

export type LedgerRow = LedgerItem;

export type CancelSessionRow = {
  id: string;
  stripe_customer_id: string;
  stripe_subscription_id: string;
  reason: string | null;
  reason_label: string | null;
  reason_detail: string | null;
  offer_shown: Record<string, unknown> | null;
  offers_enabled: boolean;
  status: "started" | "offer_shown" | "offer_accepted" | "canceled" | "abandoned";
  cancel_mode: string | null;
  mrr_at_start_cents: number | null;
  started_at: string;
};

export type DashboardData = {
  mrrAtRiskCents: number;
  pastDueCount: number;
  /** Saved MRR of cancel saves verified this month. */
  savedMrrCents: number;
  savedCount: number;
  /** Verified saves ÷ finished cancel sessions (accepted or cancelled) started this month. null = none yet. */
  saveRate: number | null;
  finishedSessions: number;
  /** Failed payments recovered by unquit (billable dunning saves) this month. */
  recoveredCents: number;
  recoveredCount: number;
  /** Next statement so far: unbilled fees, the cap, credits. */
  fees: RunningTotal;
  ledger: LedgerRow[];
  cancelSessions: CancelSessionRow[];
};

/** First instant of the current calendar month (UTC). */
export function monthStart(now = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

function sum(rows: readonly Record<string, unknown>[] | null, key: string): number {
  return (rows ?? []).reduce((acc, row) => acc + Number(row[key] ?? 0), 0);
}

/** Pure: the save-rate maths, so the card's definition is tested. */
export function saveRate(finishedSessions: number, verifiedFromThoseSessions: number): number | null {
  if (finishedSessions <= 0) return null;
  return Math.min(1, verifiedFromThoseSessions / finishedSessions);
}

/**
 * Everything the overview shows, read with the founder's own (RLS-bound)
 * Supabase client so they can only ever see their own numbers.
 */
export async function loadDashboardData(
  supabase: SupabaseClient,
  accountId: string,
  filters: LedgerFilters = { type: null, status: null, month: null },
  now = new Date(),
): Promise<DashboardData> {
  const startIso = monthStart(now).toISOString();

  const [pastDue, verifiedCancel, recovered, finished, recentSessions, ledger, fees] = await Promise.all([
    supabase.from("subscriptions_cache").select("mrr_cents").eq("account_id", accountId).eq("status", "past_due"),
    supabase
      .from("saves")
      .select("saved_mrr_cents")
      .eq("account_id", accountId)
      .eq("type", "cancel")
      .in("status", ["verified", "disputed"])
      .gte("verified_at", startIso),
    supabase
      .from("saves")
      .select("recovered_amount_cents")
      .eq("account_id", accountId)
      .eq("type", "dunning")
      .in("status", ["verified", "disputed"])
      .gte("verified_at", startIso),
    supabase
      .from("cancel_sessions")
      .select("id")
      .eq("account_id", accountId)
      .in("status", ["offer_accepted", "canceled"])
      .gte("started_at", startIso)
      .limit(5000),
    supabase
      .from("cancel_sessions")
      .select(
        "id, stripe_customer_id, stripe_subscription_id, reason, reason_label, reason_detail, offer_shown, offers_enabled, status, cancel_mode, mrr_at_start_cents, started_at",
      )
      .eq("account_id", accountId)
      .order("started_at", { ascending: false })
      .limit(25),
    loadLedger(supabase, accountId, filters),
    loadRunningTotal(supabase, accountId, now),
  ]);

  for (const result of [pastDue, verifiedCancel, recovered, finished, recentSessions]) {
    if (result.error) throw new Error(`Loading dashboard failed: ${result.error.message}`);
  }

  const sessionIds = (finished.data ?? []).map((r) => r.id as string);
  let verifiedFromSessions = 0;
  if (sessionIds.length > 0) {
    const { count, error } = await supabase
      .from("saves")
      .select("id", { count: "exact", head: true })
      .eq("account_id", accountId)
      .in("cancel_session_id", sessionIds)
      .in("status", ["verified", "disputed", "clawed_back"]);
    if (error) throw new Error(`Loading dashboard failed: ${error.message}`);
    verifiedFromSessions = count ?? 0;
  }

  return {
    mrrAtRiskCents: sum(pastDue.data, "mrr_cents"),
    pastDueCount: pastDue.data?.length ?? 0,
    savedMrrCents: sum(verifiedCancel.data, "saved_mrr_cents"),
    savedCount: verifiedCancel.data?.length ?? 0,
    saveRate: saveRate(sessionIds.length, verifiedFromSessions),
    finishedSessions: sessionIds.length,
    recoveredCents: sum(recovered.data, "recovered_amount_cents"),
    recoveredCount: recovered.data?.length ?? 0,
    fees,
    ledger,
    cancelSessions: (recentSessions.data ?? []) as CancelSessionRow[],
  };
}
