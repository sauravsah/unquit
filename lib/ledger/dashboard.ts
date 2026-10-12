/**
 * The ledger table (overview), its filters and its CSV export, plus the
 * founder's running fee total. All reads use the founder's RLS-bound client.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { buildStatement, creditOwedCents, type Statement, type StatementLine } from "@/lib/billing/statement";
import { MONTHLY_FEE_CAP_CENTS } from "@/lib/pricing";
import { monthFromSlug, monthKey, netCents } from "./fees";
import type { LedgerCsvRow } from "./csv";
import { SAVE_COLUMNS, type SaveRow, type SaveStatus, type SaveType } from "./types";

export type LedgerFilters = { type: SaveType | null; status: SaveStatus | null; month: string | null };

const TYPES: SaveType[] = ["cancel", "dunning"];
const STATUSES: SaveStatus[] = ["pending", "verified", "disputed", "clawed_back", "lost"];

/** ?type=cancel&status=verified&month=2026-09 -> filters (anything unknown is ignored). */
export function parseLedgerFilters(params: Record<string, string | string[] | undefined> | URLSearchParams): LedgerFilters {
  const get = (k: string) => {
    const v = params instanceof URLSearchParams ? params.get(k) : params[k];
    return Array.isArray(v) ? v[0] : (v ?? null);
  };
  const type = get("type");
  const status = get("status");
  const month = get("month");
  return {
    type: TYPES.includes(type as SaveType) ? (type as SaveType) : null,
    status: STATUSES.includes(status as SaveStatus) ? (status as SaveStatus) : null,
    month: month && monthFromSlug(month) ? month : null,
  };
}

export function filtersToQuery(f: LedgerFilters): string {
  const q = new URLSearchParams();
  if (f.type) q.set("type", f.type);
  if (f.status) q.set("status", f.status);
  if (f.month) q.set("month", f.month);
  const s = q.toString();
  return s ? `?${s}` : "";
}

export type LedgerItem = SaveRow & { fee_months: number; clawed_back_cents: number; held: boolean };

/** Saves matching the filters, newest first, with their fee-line totals. Month = month verified (or created, if never verified). */
export async function loadLedger(supabase: SupabaseClient, accountId: string, filters: LedgerFilters, limit = 100): Promise<LedgerItem[]> {
  let q = supabase.from("saves").select(SAVE_COLUMNS).eq("account_id", accountId).order("created_at", { ascending: false }).limit(limit);
  if (filters.type) q = q.eq("type", filters.type);
  if (filters.status) q = q.eq("status", filters.status);
  if (filters.month) {
    const start = monthFromSlug(filters.month)!;
    const [y, m] = start.split("-").map(Number) as [number, number];
    const from = new Date(Date.UTC(y, m - 1, 1)).toISOString();
    const to = new Date(Date.UTC(y, m, 1)).toISOString();
    q = q.or(`and(verified_at.gte."${from}",verified_at.lt."${to}"),and(verified_at.is.null,created_at.gte."${from}",created_at.lt."${to}")`);
  }
  const { data, error } = await q;
  if (error) throw new Error(`Loading ledger failed: ${error.message}`);
  const saves = (data ?? []) as SaveRow[];
  if (saves.length === 0) return [];

  const { data: lines, error: lineError } = await supabase
    .from("save_fee_lines")
    .select("save_id, amount_cents, clawed_back_cents, held_stripe_dispute_id, held_founder_dispute_id")
    .in("save_id", saves.map((s) => s.id));
  if (lineError) throw new Error(`Loading ledger failed: ${lineError.message}`);
  const bySave = new Map<string, { months: number; clawed: number; held: boolean }>();
  for (const l of lines ?? []) {
    const agg = bySave.get(l.save_id as string) ?? { months: 0, clawed: 0, held: false };
    agg.months++;
    agg.clawed += Number(l.clawed_back_cents ?? 0);
    agg.held ||= !!l.held_stripe_dispute_id || !!l.held_founder_dispute_id;
    bySave.set(l.save_id as string, agg);
  }
  return saves.map((s) => {
    const agg = bySave.get(s.id);
    return { ...s, fee_months: agg?.months ?? 0, clawed_back_cents: agg?.clawed ?? 0, held: agg?.held ?? false };
  });
}

export function toCsvRows(items: readonly LedgerItem[]): LedgerCsvRow[] {
  return items.map((s) => ({
    receipt_number: s.receipt_number,
    type: s.type,
    status: s.status,
    customer_email: s.customer_email,
    stripe_customer_id: s.stripe_customer_id,
    stripe_subscription_id: s.stripe_subscription_id,
    stripe_invoice_id: s.stripe_invoice_id,
    offer: s.offer,
    attributed_via: s.attributed_via,
    saved_mrr_cents: Number(s.saved_mrr_cents),
    recovered_amount_cents: Number(s.recovered_amount_cents),
    currency: s.currency,
    fee_cents: Number(s.fee_cents),
    clawed_back_cents: s.clawed_back_cents,
    fee_months: s.fee_months,
    lost_reason: s.lost_reason,
    verified_at: s.verified_at,
    created_at: s.created_at,
  }));
}

type LineJoin = {
  id: string;
  save_id: string;
  amount_cents: number;
  clawed_back_cents: number;
  billing_period_id: string | null;
  saves: { type: SaveType } | null;
};

const toLine = (r: LineJoin): StatementLine => ({
  id: r.id,
  saveId: r.save_id,
  kind: r.saves?.type === "dunning" ? "dunning" : "cancel",
  amountCents: Number(r.amount_cents),
  clawedBackCents: Number(r.clawed_back_cents ?? 0),
});

export type RunningTotal = Statement & { heldCents: number; month: string };

/**
 * What next month's bill looks like so far: unbilled, unheld fee lines up to
 * this month, the cap, and any credit owed from earlier statements. Exactly
 * what the 1st-of-the-month run will compute if nothing else happens.
 */
export async function loadRunningTotal(supabase: SupabaseClient, accountId: string, now = new Date()): Promise<RunningTotal> {
  const month = monthKey(now);
  const [unbilled, periods] = await Promise.all([
    supabase
      .from("save_fee_lines")
      .select("id, save_id, amount_cents, clawed_back_cents, billing_period_id, held_stripe_dispute_id, held_founder_dispute_id, saves!inner(type)")
      .eq("account_id", accountId)
      .is("billing_period_id", null)
      .eq("status", "earned")
      .lte("billing_month", month),
    supabase.from("billing_periods").select("id, capped_cents, cap_cents, credit_applied_cents, status").eq("account_id", accountId).in("status", ["invoiced", "zero"]),
  ]);
  if (unbilled.error) throw new Error(`Loading fees failed: ${unbilled.error.message}`);
  if (periods.error) throw new Error(`Loading statements failed: ${periods.error.message}`);

  const rows = (unbilled.data ?? []) as unknown as (LineJoin & { held_stripe_dispute_id: string | null; held_founder_dispute_id: string | null })[];
  const billable = rows.filter((r) => !r.held_stripe_dispute_id && !r.held_founder_dispute_id);
  const heldCents = rows.filter((r) => r.held_stripe_dispute_id || r.held_founder_dispute_id).reduce((a, r) => a + netCents(r), 0);

  const closed = (periods.data ?? []) as { id: string; capped_cents: number; cap_cents: number; credit_applied_cents: number }[];
  let owed = 0;
  if (closed.length > 0) {
    const { data: closedLines, error } = await supabase
      .from("save_fee_lines")
      .select("id, save_id, amount_cents, clawed_back_cents, billing_period_id, saves!inner(type)")
      .in("billing_period_id", closed.map((p) => p.id));
    if (error) throw new Error(`Loading statements failed: ${error.message}`);
    const byPeriod = new Map<string, StatementLine[]>();
    for (const r of (closedLines ?? []) as unknown as LineJoin[]) {
      const list = byPeriod.get(r.billing_period_id!) ?? [];
      list.push(toLine(r));
      byPeriod.set(r.billing_period_id!, list);
    }
    owed = creditOwedCents(
      closed.map((p) => ({
        id: p.id,
        cappedCents: Number(p.capped_cents),
        capCents: Number(p.cap_cents),
        creditAppliedCents: Number(p.credit_applied_cents),
        lines: byPeriod.get(p.id) ?? [],
      })),
    );
  }
  return { ...buildStatement(billable.map(toLine), owed, MONTHLY_FEE_CAP_CENTS), heldCents, month };
}
