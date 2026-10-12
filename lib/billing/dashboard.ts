import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { PERIOD_COLUMNS, type PeriodRow } from "./service";

export type BillingAccountView = {
  platform_customer_id: string | null;
  billing_pm_status: "none" | "active";
  billing_pm_brand: string | null;
  billing_pm_last4: string | null;
  billing_pm_updated_at: string | null;
};

/** The founder's own statements and card status (RLS-bound client). */
export async function loadBillingPage(supabase: SupabaseClient, accountId: string): Promise<{ account: BillingAccountView; periods: PeriodRow[] }> {
  const [account, periods] = await Promise.all([
    supabase
      .from("accounts")
      .select("platform_customer_id, billing_pm_status, billing_pm_brand, billing_pm_last4, billing_pm_updated_at")
      .eq("id", accountId)
      .single(),
    supabase.from("billing_periods").select(PERIOD_COLUMNS).eq("account_id", accountId).order("period_month", { ascending: false }).limit(36),
  ]);
  if (account.error) throw new Error(`Loading billing failed: ${account.error.message}`);
  if (periods.error) throw new Error(`Loading statements failed: ${periods.error.message}`);
  return { account: account.data as BillingAccountView, periods: (periods.data ?? []) as PeriodRow[] };
}

export type StatementLineView = {
  id: string;
  month_index: number;
  billing_month: string;
  amount_cents: number;
  clawed_back_cents: number;
  stripe_invoice_id: string | null;
  saves: { receipt_number: string; type: "cancel" | "dunning"; customer_email: string | null; stripe_customer_id: string } | null;
};

const LINE_SELECT = "id, month_index, billing_month, amount_cents, clawed_back_cents, stripe_invoice_id, saves!inner(receipt_number, type, customer_email, stripe_customer_id)";

export async function loadStatement(
  supabase: SupabaseClient,
  accountId: string,
  month: string,
): Promise<{ period: PeriodRow | null; lines: StatementLineView[] }> {
  const { data: period, error } = await supabase.from("billing_periods").select(PERIOD_COLUMNS).eq("account_id", accountId).eq("period_month", month).maybeSingle();
  if (error) throw new Error(`Loading statement failed: ${error.message}`);
  const q = period
    ? supabase.from("save_fee_lines").select(LINE_SELECT).eq("billing_period_id", (period as PeriodRow).id)
    : supabase.from("save_fee_lines").select(LINE_SELECT).eq("account_id", accountId).is("billing_period_id", null).eq("status", "earned").lte("billing_month", month).is("held_stripe_dispute_id", null).is("held_founder_dispute_id", null);
  const { data: lines, error: lineError } = await q.order("billing_month");
  if (lineError) throw new Error(`Loading statement failed: ${lineError.message}`);
  return { period: (period as PeriodRow | null) ?? null, lines: (lines ?? []) as unknown as StatementLineView[] };
}
