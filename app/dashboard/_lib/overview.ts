import "server-only";
import type { ActivityItem } from "@/components/dashboard/activity";
import { loadActivity } from "@/lib/activity";
import { attempt, queryOne, type Db } from "@/lib/db/core";

/**
 * Read-only extras for the redesigned Overview (charts, deltas, activity,
 * onboarding). Display only: every fee and save rule stays in lib/. Every
 * query is scoped by the founder's account id, so it only reads their rows.
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

export async function loadOverviewExtras(db: Db, accountId: string): Promise<OverviewExtras> {
  const now = new Date();
  const { thisMonth, lastMonth } = monthBounds(now);
  const firstWeek = new Date(weekStart(now).getTime() - (WEEKS - 1) * 7 * DAY);
  const since = new Date(Math.min(firstWeek.getTime(), lastMonth.getTime())).toISOString();

  const load = <T>(text: string, params: unknown[]) => attempt("Loading overview", () => db.query<T>(text, params));
  const exists = (text: string) =>
    attempt("Loading overview", async () => !!(await queryOne(db, `select exists (${text}) as ok`, [accountId]))?.ok);

  const [saves, recoveries, sessions, activity, flowSaved, dunningOn, anySession, anySave] = await Promise.all([
    load<{ saved_mrr_cents: number; verified_at: string | null }>(
      `select saved_mrr_cents, verified_at from saves
        where account_id = $1 and type = 'cancel' and status in ('verified', 'disputed') and verified_at >= $2`,
      [accountId, since],
    ),
    // Recoveries credited to unquit are dunning saves (same definition as lib/dashboard.ts).
    load<{ recovered_amount_cents: number | null; verified_at: string | null }>(
      `select recovered_amount_cents, verified_at from saves
        where account_id = $1 and type = 'dunning' and status in ('verified', 'disputed') and verified_at >= $2`,
      [accountId, since],
    ),
    load<{ reason: string | null; reason_label: string | null; started_at: string }>(
      "select reason, reason_label, started_at from cancel_sessions where account_id = $1 and started_at >= $2",
      [accountId, since],
    ),
    loadActivity(db, accountId),
    exists("select 1 from flows where account_id = $1"),
    exists("select 1 from dunning_settings where account_id = $1 and enabled"),
    exists("select 1 from cancel_sessions where account_id = $1"),
    exists("select 1 from saves where account_id = $1"),
  ]);

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
  for (const s of saves) {
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
  for (const r of recoveries) {
    if (!r.verified_at) continue;
    const at = new Date(r.verified_at);
    const amount = Number(r.recovered_amount_cents ?? 0);
    const b = buckets.get(weekStart(at).getTime());
    if (b) b.recovered += amount / 100;
    if (at >= thisMonth) recThis += amount;
    else if (at >= lastMonth) recLast += amount;
  }

  // Cancel reasons (last 90 days), top 5 + "Other".
  const ninety = now.getTime() - 90 * DAY;
  const counts = new Map<string, number>();
  let lastMonthAttempts = 0;
  for (const c of sessions) {
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
    activity,
    checklist: {
      flowSaved,
      widgetUsed: anySession,
      dunningOn,
      firstSave: anySave || savedThisCount > 0,
    },
  };
}

/** Relative change, or null when there is nothing to compare with. */
export function relativeDelta(current: number, previous: number): number | null {
  if (previous <= 0) return null;
  return (current - previous) / previous;
}

export type SetupStatus = { flowSaved: boolean; widgetUsed: boolean; dunningOn: boolean };

/**
 * Just the "Get set up" ticks, for the setup guide (/dashboard/install). Same
 * definitions as `checklist` in loadOverviewExtras, scoped to the founder's account.
 */
export async function loadSetupStatus(db: Db, accountId: string): Promise<SetupStatus> {
  const exists = (text: string) =>
    attempt("Loading setup status", async () => !!(await queryOne(db, `select exists (${text}) as ok`, [accountId]))?.ok);
  const [flowSaved, widgetUsed, dunningOn] = await Promise.all([
    exists("select 1 from flows where account_id = $1"),
    exists("select 1 from cancel_sessions where account_id = $1"),
    exists("select 1 from dunning_settings where account_id = $1 and enabled"),
  ]);
  return { flowSaved, widgetUsed, dunningOn };
}
