import "server-only";
import { attempt, queryOne, type Db } from "@/lib/db/core";
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

function sum<T extends object>(rows: readonly T[] | null, key: keyof T & string): number {
  return (rows ?? []).reduce((acc, row) => acc + Number((row as Record<string, unknown>)[key] ?? 0), 0);
}

/** Pure: the save-rate maths, so the card's definition is tested. */
export function saveRate(finishedSessions: number, verifiedFromThoseSessions: number): number | null {
  if (finishedSessions <= 0) return null;
  return Math.min(1, verifiedFromThoseSessions / finishedSessions);
}

/**
 * Everything the overview shows. Every query is scoped by the signed-in
 * founder's account id, so they can only ever see their own numbers.
 */
export async function loadDashboardData(
  db: Db,
  accountId: string,
  filters: LedgerFilters = { type: null, status: null, month: null },
  now = new Date(),
): Promise<DashboardData> {
  const startIso = monthStart(now).toISOString();
  const load = <T>(text: string, params: unknown[]) => attempt("Loading dashboard", () => db.query<T>(text, params));

  const [pastDue, verifiedCancel, recovered, finished, recentSessions, ledger, fees] = await Promise.all([
    load<{ mrr_cents: number }>("select mrr_cents from subscriptions_cache where account_id = $1 and status = 'past_due'", [accountId]),
    load<{ saved_mrr_cents: number }>(
      `select saved_mrr_cents from saves
        where account_id = $1 and type = 'cancel' and status in ('verified', 'disputed') and verified_at >= $2`,
      [accountId, startIso],
    ),
    load<{ recovered_amount_cents: number }>(
      `select recovered_amount_cents from saves
        where account_id = $1 and type = 'dunning' and status in ('verified', 'disputed') and verified_at >= $2`,
      [accountId, startIso],
    ),
    load<{ id: string }>(
      `select id from cancel_sessions
        where account_id = $1 and status in ('offer_accepted', 'canceled') and started_at >= $2
        limit 5000`,
      [accountId, startIso],
    ),
    load<CancelSessionRow>(
      `select id, stripe_customer_id, stripe_subscription_id, reason, reason_label, reason_detail, offer_shown, offers_enabled,
              status, cancel_mode, mrr_at_start_cents, started_at
         from cancel_sessions
        where account_id = $1
        order by started_at desc
        limit 25`,
      [accountId],
    ),
    loadLedger(db, accountId, filters),
    loadRunningTotal(db, accountId, now),
  ]);

  const sessionIds = finished.map((r) => r.id);
  let verifiedFromSessions = 0;
  if (sessionIds.length > 0) {
    const row = await attempt("Loading dashboard", () =>
      queryOne<{ n: number }>(
        db,
        `select count(*) as n from saves
          where account_id = $1 and cancel_session_id = any($2) and status in ('verified', 'disputed', 'clawed_back')`,
        [accountId, sessionIds],
      ),
    );
    verifiedFromSessions = Number(row?.n ?? 0);
  }

  return {
    mrrAtRiskCents: sum(pastDue, "mrr_cents"),
    pastDueCount: pastDue.length,
    savedMrrCents: sum(verifiedCancel, "saved_mrr_cents"),
    savedCount: verifiedCancel.length,
    saveRate: saveRate(sessionIds.length, verifiedFromSessions),
    finishedSessions: sessionIds.length,
    recoveredCents: sum(recovered, "recovered_amount_cents"),
    recoveredCount: recovered.length,
    fees,
    ledger,
    cancelSessions: recentSessions,
  };
}
