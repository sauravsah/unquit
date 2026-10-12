import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { calculateMonthlyBill, type FeeLine, type MonthlyBill } from "@/lib/pricing";

export type LedgerRow = {
  id: string;
  type: "cancel" | "dunning";
  status: "pending" | "verified" | "disputed" | "clawed_back";
  stripe_customer_id: string;
  saved_mrr_cents: number;
  recovered_amount_cents: number;
  fee_cents: number;
  currency: string;
  receipt_number: string;
  verified_at: string | null;
  created_at: string;
};

export type DashboardData = {
  mrrAtRiskCents: number;
  pastDueCount: number;
  savedMrrCents: number;
  saveRate: number | null; // 0..1, null when no cancel attempts yet
  bill: MonthlyBill;
  ledger: LedgerRow[];
};

/** First instant of the current calendar month (UTC). */
export function monthStart(now = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

function sum(rows: readonly Record<string, unknown>[] | null, key: string): number {
  return (rows ?? []).reduce((acc, row) => acc + Number(row[key] ?? 0), 0);
}

/**
 * Everything the dashboard shows, read with the founder's own (RLS-bound)
 * Supabase client so they can only ever see their own numbers.
 */
export async function loadDashboardData(supabase: SupabaseClient, accountId: string): Promise<DashboardData> {
  const start = monthStart();
  const startIso = start.toISOString();
  const billingMonth = startIso.slice(0, 10);

  const [pastDue, verifiedSaves, cancelSessions, feeLines, ledger] = await Promise.all([
    supabase.from("subscriptions_cache").select("mrr_cents").eq("account_id", accountId).eq("status", "past_due"),
    supabase
      .from("saves")
      .select("saved_mrr_cents")
      .eq("account_id", accountId)
      .eq("type", "cancel")
      .eq("status", "verified")
      .gte("verified_at", startIso),
    supabase
      .from("cancel_sessions")
      .select("id", { count: "exact", head: true })
      .eq("account_id", accountId)
      .gte("started_at", startIso),
    supabase
      .from("save_fee_lines")
      .select("save_id, amount_cents, status, saves(type)")
      .eq("account_id", accountId)
      .eq("billing_month", billingMonth),
    supabase
      .from("saves")
      .select(
        "id, type, status, stripe_customer_id, saved_mrr_cents, recovered_amount_cents, fee_cents, currency, receipt_number, verified_at, created_at",
      )
      .eq("account_id", accountId)
      .order("created_at", { ascending: false })
      .limit(25),
  ]);

  for (const result of [pastDue, verifiedSaves, cancelSessions, feeLines, ledger]) {
    if (result.error) throw new Error(`Loading dashboard failed: ${result.error.message}`);
  }

  const verifiedCount = verifiedSaves.data?.length ?? 0;
  const attempts = cancelSessions.count ?? 0;

  const lines: FeeLine[] = (feeLines.data ?? []).map((row) => {
    const r = row as unknown as { save_id: string; amount_cents: number; status: string; saves: { type: string } | null };
    return {
      saveId: r.save_id,
      kind: r.saves?.type === "dunning" ? "dunning" : "cancel",
      amountCents: Number(r.amount_cents),
      clawedBack: r.status === "clawed_back",
    };
  });

  return {
    mrrAtRiskCents: sum(pastDue.data, "mrr_cents"),
    pastDueCount: pastDue.data?.length ?? 0,
    savedMrrCents: sum(verifiedSaves.data, "saved_mrr_cents"),
    saveRate: attempts > 0 ? verifiedCount / attempts : null,
    bill: calculateMonthlyBill(lines),
    ledger: (ledger.data ?? []) as LedgerRow[],
  };
}
