import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { StatementLine } from "./statement";
import { PERIOD_COLUMNS, type BillingAccount, type BillingRepo, type PeriodRow } from "./service";

function fail(what: string, error: { message: string }): never {
  throw new Error(`${what} failed: ${error.message}`);
}

type LineJoin = { id: string; save_id: string; amount_cents: number; clawed_back_cents: number; saves: { type: "cancel" | "dunning" } | null };

export function toStatementLine(row: LineJoin): StatementLine {
  return {
    id: row.id,
    saveId: row.save_id,
    kind: row.saves?.type === "dunning" ? "dunning" : "cancel",
    amountCents: Number(row.amount_cents),
    clawedBackCents: Number(row.clawed_back_cents ?? 0),
  };
}

export const STATEMENT_LINE_SELECT = "id, save_id, amount_cents, clawed_back_cents, saves!inner(type)";

/** The owner's sign-in email (service role only). */
export async function ownerEmail(admin: SupabaseClient, ownerUserId: string): Promise<string | null> {
  const { data, error } = await admin.auth.admin.getUserById(ownerUserId);
  if (error) return null;
  return data.user?.email ?? null;
}

/** Billing's database side (service role: the cron and server routes only). */
export function createBillingRepo(admin: SupabaseClient): BillingRepo {
  return {
    async accountsToBill(month) {
      const [y, m] = month.split("-").map(Number) as [number, number];
      const nextMonth = new Date(Date.UTC(y, m, 1)).toISOString();
      const [connected, unbilled] = await Promise.all([
        admin.from("accounts").select("id").eq("stripe_connection_status", "connected").lt("stripe_connected_at", nextMonth),
        admin.from("save_fee_lines").select("account_id").is("billing_period_id", null).eq("status", "earned").lte("billing_month", month),
      ]);
      if (connected.error) fail("Loading accounts", connected.error);
      if (unbilled.error) fail("Loading unbilled fee lines", unbilled.error);
      return [...new Set([...(connected.data ?? []).map((r) => r.id as string), ...(unbilled.data ?? []).map((r) => r.account_id as string)])];
    },

    async getBillingAccount(accountId): Promise<BillingAccount | null> {
      const { data, error } = await admin
        .from("accounts")
        .select("id, name, owner_user_id, platform_customer_id, billing_pm_status")
        .eq("id", accountId)
        .maybeSingle();
      if (error) fail("Loading account", error);
      if (!data) return null;
      return {
        id: data.id as string,
        name: (data.name as string | null) ?? null,
        email: await ownerEmail(admin, data.owner_user_id as string),
        platform_customer_id: (data.platform_customer_id as string | null) ?? null,
        billing_pm_status: (data.billing_pm_status as "none" | "active") ?? "none",
      };
    },

    async setPlatformCustomer(accountId, customerId) {
      const { error } = await admin.from("accounts").update({ platform_customer_id: customerId }).eq("id", accountId).is("platform_customer_id", null);
      if (error) fail("Saving platform customer", error);
      const { data, error: readError } = await admin.from("accounts").select("platform_customer_id").eq("id", accountId).single();
      if (readError) fail("Loading platform customer", readError);
      return data.platform_customer_id as string;
    },

    async getPeriod(accountId, month) {
      const { data, error } = await admin.from("billing_periods").select(PERIOD_COLUMNS).eq("account_id", accountId).eq("period_month", month).maybeSingle();
      if (error) fail("Loading billing period", error);
      return (data as PeriodRow | null) ?? null;
    },

    async ensurePeriod(accountId, month, capCents) {
      const { error } = await admin
        .from("billing_periods")
        .upsert({ account_id: accountId, period_month: month, cap_cents: capCents }, { onConflict: "account_id,period_month", ignoreDuplicates: true });
      if (error) fail("Claiming billing period", error);
      const period = await this.getPeriod(accountId, month);
      if (!period) throw new Error(`Billing period ${accountId} ${month} vanished`);
      return period;
    },

    async lockPeriod(periodId, at, staleBefore) {
      const { data: current, error: readError } = await admin.from("billing_periods").select("attempts").eq("id", periodId).single();
      if (readError) fail("Loading billing period", readError);
      const { data, error } = await admin
        .from("billing_periods")
        .update({ locked_at: at, attempts: Number(current.attempts) + 1, status: "building" })
        .eq("id", periodId)
        .eq("attempts", current.attempts) // compare-and-set
        .in("status", ["building", "failed"])
        .or(`locked_at.is.null,locked_at.lt."${staleBefore}"`)
        .select(PERIOD_COLUMNS);
      if (error) fail("Locking billing period", error);
      return ((data ?? [])[0] as PeriodRow | undefined) ?? null;
    },

    async assignLines(accountId, periodId, month, at) {
      const { error } = await admin
        .from("save_fee_lines")
        .update({ billing_period_id: periodId, status: "billed", billed_at: at })
        .eq("account_id", accountId)
        .is("billing_period_id", null)
        .eq("status", "earned")
        .lte("billing_month", month)
        .is("held_stripe_dispute_id", null)
        .is("held_founder_dispute_id", null);
      if (error) fail("Assigning fee lines", error);
    },

    async linesForPeriod(periodId) {
      const { data, error } = await admin.from("save_fee_lines").select(STATEMENT_LINE_SELECT).eq("billing_period_id", periodId);
      if (error) fail("Loading statement lines", error);
      return ((data ?? []) as unknown as LineJoin[]).map(toStatementLine);
    },

    async closedPeriods(accountId, exceptPeriodId) {
      const { data, error } = await admin
        .from("billing_periods")
        .select(PERIOD_COLUMNS)
        .eq("account_id", accountId)
        .in("status", ["invoiced", "zero"])
        .neq("id", exceptPeriodId)
        .order("period_month");
      if (error) fail("Loading billing periods", error);
      return (data ?? []) as PeriodRow[];
    },

    async updatePeriod(periodId, fields) {
      const { error } = await admin.from("billing_periods").update(fields).eq("id", periodId);
      if (error) fail("Updating billing period", error);
    },
  };
}
