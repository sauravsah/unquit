import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  CASE_COLUMNS,
  SAVE_COLUMNS,
  SESSION_COLUMNS,
  buildActivity,
  type ActivityItem,
  type CaseActivityRow,
  type SaveActivityRow,
  type SessionActivityRow,
} from "@/components/dashboard/activity";

/**
 * Read-only extras for the redesigned Overview (charts, deltas, activity,
 * onboarding). Display only: every fee and save rule stays in lib/. Uses the
 * founder's RLS-bound client, so it can only read their own rows.
 */

export type TrendPoint = { label: string; saved: number; recovered: number };
export type ReasonSlice = { reason: string; count: number };

export type OverviewExtras = {
  trend: TrendPoint[];
  reasons: ReasonSlice[];
  savedMrrLastMonthCents: number;
  recoveredThisMonthCents: number;
  recoveredLastMonthCents: number;
  saveRateLastMonth: number | null;
  activity: ActivityItem[];
  checklist: { flowSaved: boolean; widgetUsed: boolean; dunningOn: boolean; firstSave: boolean };
};

const WEEKS = 12;
const DAY = 86_400_000;

function monthBounds(now = new Date()) {
  const thisMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const lastMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  return { thisMonth, lastMonth };
}

/** Monday 00:00 UTC of the week containing `d`. */
function weekStart(d: Date): Date {
  const day = (d.getUTCDay() + 6) % 7;
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day));
}

export async function loadOverviewExtras(supabase: SupabaseClient, accountId: string): Promise<OverviewExtras> {
  const now = new Date();
  const { thisMonth, lastMonth } = monthBounds(now);
  const firstWeek = new Date(weekStart(now).getTime() - (WEEKS - 1) * 7 * DAY);
  const since = new Date(Math.min(firstWeek.getTime(), lastMonth.getTime())).toISOString();

  const [saves, recoveries, sessions, recentSaves, recentSessions, recentCases, flow, dunning, anySession, anySave] = await Promise.all([
    supabase
      .from("saves")
      .select("saved_mrr_cents, verified_at")
      .eq("account_id", accountId)
      .eq("type", "cancel")
      .eq("status", "verified")
      .gte("verified_at", since),
    supabase
      .from("dunning_cases")
      .select("recovered_amount_cents, recovered_via, recovered_at")
      .eq("account_id", accountId)
      .eq("status", "recovered")
      .gte("recovered_at", since),
    supabase.from("cancel_sessions").select("reason, reason_label, started_at").eq("account_id", accountId).gte("started_at", since),
    supabase.from("saves").select(SAVE_COLUMNS).eq("account_id", accountId).order("created_at", { ascending: false }).limit(15),
    supabase.from("cancel_sessions").select(SESSION_COLUMNS).eq("account_id", accountId).order("started_at", { ascending: false }).limit(15),
    supabase.from("dunning_cases").select(CASE_COLUMNS).eq("account_id", accountId).order("opened_at", { ascending: false }).limit(15),
    supabase.from("flows").select("account_id").eq("account_id", accountId).maybeSingle(),
    supabase.from("dunning_settings").select("enabled").eq("account_id", accountId).maybeSingle(),
    supabase.from("cancel_sessions").select("id", { count: "exact", head: true }).eq("account_id", accountId),
    supabase.from("saves").select("id", { count: "exact", head: true }).eq("account_id", accountId),
  ]);
  for (const r of [saves, recoveries, sessions, recentSaves, recentSessions, recentCases]) {
    if (r.error) throw new Error(`Loading overview failed: ${r.error.message}`);
  }

  // Weekly trend (dollars, for the chart).
  const buckets = new Map<number, TrendPoint>();
  for (let i = 0; i < WEEKS; i++) {
    const start = new Date(firstWeek.getTime() + i * 7 * DAY);
    buckets.set(start.getTime(), {
      label: start.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" }),
      saved: 0,
      recovered: 0,
    });
  }
  let savedLast = 0;
  let savedThisCount = 0;
  let savedLastCount = 0;
  for (const s of (saves.data ?? []) as { saved_mrr_cents: number; verified_at: string | null }[]) {
    if (!s.verified_at) continue;
    const at = new Date(s.verified_at);
    const b = buckets.get(weekStart(at).getTime());
    if (b) b.saved += Number(s.saved_mrr_cents) / 100;
    if (at >= lastMonth && at < thisMonth) {
      savedLast += Number(s.saved_mrr_cents);
      savedLastCount++;
    }
    if (at >= thisMonth) savedThisCount++;
  }
  let recThis = 0;
  let recLast = 0;
  for (const r of (recoveries.data ?? []) as { recovered_amount_cents: number | null; recovered_via: string | null; recovered_at: string | null }[]) {
    if (!r.recovered_at) continue;
    const byUnquit = r.recovered_via === "update_link" || r.recovered_via === "unquit_retry";
    const at = new Date(r.recovered_at);
    const amount = Number(r.recovered_amount_cents ?? 0);
    const b = buckets.get(weekStart(at).getTime());
    if (b && byUnquit) b.recovered += amount / 100;
    if (!byUnquit) continue;
    if (at >= thisMonth) recThis += amount;
    else if (at >= lastMonth) recLast += amount;
  }

  // Cancel reasons (last 90 days), top 5 + "Other".
  const ninety = now.getTime() - 90 * DAY;
  const counts = new Map<string, number>();
  let lastMonthAttempts = 0;
  for (const c of (sessions.data ?? []) as { reason: string | null; reason_label: string | null; started_at: string }[]) {
    const at = new Date(c.started_at);
    if (at >= lastMonth && at < thisMonth) lastMonthAttempts++;
    if (at.getTime() < ninety) continue;
    const key = c.reason_label ?? c.reason ?? "No reason given";
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const reasons: ReasonSlice[] = sorted.slice(0, 5).map(([reason, count]) => ({ reason, count }));
  const other = sorted.slice(5).reduce((n, [, c]) => n + c, 0);
  if (other > 0) reasons.push({ reason: "Other", count: other });

  return {
    trend: [...buckets.values()],
    reasons,
    savedMrrLastMonthCents: savedLast,
    recoveredThisMonthCents: recThis,
    recoveredLastMonthCents: recLast,
    saveRateLastMonth: lastMonthAttempts > 0 ? savedLastCount / lastMonthAttempts : null,
    activity: buildActivity(
      (recentSaves.data ?? []) as SaveActivityRow[],
      (recentSessions.data ?? []) as SessionActivityRow[],
      (recentCases.data ?? []) as CaseActivityRow[],
    ),
    checklist: {
      flowSaved: !!flow.data,
      widgetUsed: (anySession.count ?? 0) > 0,
      dunningOn: !!(dunning.data as { enabled?: boolean } | null)?.enabled,
      firstSave: (anySave.count ?? 0) > 0 || savedThisCount > 0,
    },
  };
}

/** Relative change, or null when there is nothing to compare with. */
export function relativeDelta(current: number, previous: number): number | null {
  if (previous <= 0) return null;
  return (current - previous) / previous;
}
