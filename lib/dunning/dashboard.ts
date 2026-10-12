import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { monthStart } from "@/lib/dashboard";
import { calculateMonthlyBill, type FeeLine, type MonthlyBill } from "@/lib/pricing";
import type { DeclineCategory } from "./declines";
import { SETTINGS_COLUMNS, settingsFromRow, type DunningSettings, type DunningSettingsRow } from "./settings";

export type DunningCaseView = {
  id: string;
  stripe_invoice_id: string;
  stripe_customer_id: string;
  customer_email: string | null;
  customer_name: string | null;
  invoice_number: string | null;
  amount_due_cents: number;
  currency: string;
  status: "open" | "recovered" | "failed" | "closed";
  decline_code: string | null;
  decline_category: DeclineCategory | null;
  sequence_step: number;
  next_email_at: string | null;
  sequence_stop_reason: string | null;
  recovered_via: "update_link" | "unquit_retry" | "external" | null;
  recovered_amount_cents: number | null;
  opened_at: string;
  recovered_at: string | null;
  emails: { step: number; status: string; sent_at: string | null; opened_at: string | null; clicked_at: string | null }[];
  feeCents: number;
};

export type DunningDashboard = {
  settings: DunningSettings;
  hasSettingsRow: boolean;
  openCount: number;
  openAmountCents: number;
  recoveredThisMonthCents: number;
  recoveredByUnquitThisMonthCents: number;
  dunningFeesThisMonthCents: number;
  bill: MonthlyBill;
  cases: DunningCaseView[];
};

const CASE_COLUMNS =
  "id, stripe_invoice_id, stripe_customer_id, customer_email, customer_name, invoice_number, amount_due_cents, currency, status, decline_code, decline_category, sequence_step, next_email_at, sequence_stop_reason, recovered_via, recovered_amount_cents, opened_at, recovered_at";

/**
 * Everything the Dunning tab shows, read with the founder's own (RLS-bound)
 * client so they only ever see their own account.
 */
export async function loadDunningDashboard(supabase: SupabaseClient, accountId: string): Promise<DunningDashboard> {
  const startIso = monthStart().toISOString();
  const billingMonth = startIso.slice(0, 10);

  const [settings, cases, open, recovered, feeLines] = await Promise.all([
    supabase.from("dunning_settings").select(SETTINGS_COLUMNS).eq("account_id", accountId).maybeSingle(),
    supabase.from("dunning_cases").select(CASE_COLUMNS).eq("account_id", accountId).order("opened_at", { ascending: false }).limit(50),
    supabase.from("dunning_cases").select("amount_due_cents").eq("account_id", accountId).eq("status", "open"),
    supabase
      .from("dunning_cases")
      .select("recovered_amount_cents, recovered_via")
      .eq("account_id", accountId)
      .eq("status", "recovered")
      .gte("recovered_at", startIso),
    supabase
      .from("save_fee_lines")
      .select("save_id, amount_cents, status, saves(type)")
      .eq("account_id", accountId)
      .eq("billing_month", billingMonth),
  ]);
  for (const r of [settings, cases, open, recovered, feeLines]) {
    if (r.error) throw new Error(`Loading dunning dashboard failed: ${r.error.message}`);
  }

  const caseRows = (cases.data ?? []) as Omit<DunningCaseView, "emails" | "feeCents">[];
  const ids = caseRows.map((c) => c.id);
  const [emails, saves] = ids.length
    ? await Promise.all([
        supabase
          .from("dunning_emails")
          .select("dunning_case_id, step, status, sent_at, opened_at, clicked_at")
          .in("dunning_case_id", ids)
          .order("step"),
        supabase.from("saves").select("dunning_case_id, fee_cents").eq("type", "dunning").in("dunning_case_id", ids),
      ])
    : [{ data: [], error: null }, { data: [], error: null }];
  for (const r of [emails, saves]) {
    if (r.error) throw new Error(`Loading dunning dashboard failed: ${r.error.message}`);
  }

  type EmailRow = DunningCaseView["emails"][number] & { dunning_case_id: string };
  const emailsByCase = new Map<string, DunningCaseView["emails"]>();
  for (const e of (emails.data ?? []) as EmailRow[]) {
    const list = emailsByCase.get(e.dunning_case_id) ?? [];
    list.push({ step: e.step, status: e.status, sent_at: e.sent_at, opened_at: e.opened_at, clicked_at: e.clicked_at });
    emailsByCase.set(e.dunning_case_id, list);
  }
  const feeByCase = new Map<string, number>();
  for (const s of (saves.data ?? []) as { dunning_case_id: string; fee_cents: number }[]) feeByCase.set(s.dunning_case_id, Number(s.fee_cents));

  const lines: FeeLine[] = (feeLines.data ?? []).map((row) => {
    const r = row as unknown as { save_id: string; amount_cents: number; status: string; saves: { type: string } | null };
    return { saveId: r.save_id, kind: r.saves?.type === "dunning" ? "dunning" : "cancel", amountCents: Number(r.amount_cents), clawedBack: r.status === "clawed_back" };
  });

  const recoveredRows = (recovered.data ?? []) as { recovered_amount_cents: number | null; recovered_via: string | null }[];

  return {
    settings: settingsFromRow(settings.data as DunningSettingsRow | null),
    hasSettingsRow: !!settings.data,
    openCount: open.data?.length ?? 0,
    openAmountCents: (open.data ?? []).reduce((a, r) => a + Number(r.amount_due_cents ?? 0), 0),
    recoveredThisMonthCents: recoveredRows.reduce((a, r) => a + Number(r.recovered_amount_cents ?? 0), 0),
    recoveredByUnquitThisMonthCents: recoveredRows
      .filter((r) => r.recovered_via === "update_link" || r.recovered_via === "unquit_retry")
      .reduce((a, r) => a + Number(r.recovered_amount_cents ?? 0), 0),
    dunningFeesThisMonthCents: lines.filter((l) => l.kind === "dunning" && !l.clawedBack).reduce((a, l) => a + l.amountCents, 0),
    bill: calculateMonthlyBill(lines),
    cases: caseRows.map((c) => ({ ...c, emails: emailsByCase.get(c.id) ?? [], feeCents: feeByCase.get(c.id) ?? 0 })),
  };
}
