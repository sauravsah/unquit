import "server-only";
import { attempt, queryOne, type Db } from "@/lib/db/core";
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
 * Everything the Dunning tab shows. Every query is scoped by the founder's
 * account id, so they only ever see their own account.
 */
export async function loadDunningDashboard(db: Db, accountId: string): Promise<DunningDashboard> {
  const startIso = monthStart().toISOString();
  const billingMonth = startIso.slice(0, 10);
  const load = <T>(text: string, params: unknown[]) => attempt("Loading dunning dashboard", () => db.query<T>(text, params));

  const [settings, caseRows, open, recoveredRows, feeLines] = await Promise.all([
    attempt("Loading dunning dashboard", () =>
      queryOne<DunningSettingsRow>(db, `select ${SETTINGS_COLUMNS} from dunning_settings where account_id = $1`, [accountId]),
    ),
    load<Omit<DunningCaseView, "emails" | "feeCents">>(
      `select ${CASE_COLUMNS} from dunning_cases where account_id = $1 order by opened_at desc limit 50`,
      [accountId],
    ),
    load<{ amount_due_cents: number }>("select amount_due_cents from dunning_cases where account_id = $1 and status = 'open'", [accountId]),
    load<{ recovered_amount_cents: number | null; recovered_via: string | null }>(
      `select recovered_amount_cents, recovered_via from dunning_cases
        where account_id = $1 and status = 'recovered' and recovered_at >= $2`,
      [accountId, startIso],
    ),
    load<{ save_id: string; amount_cents: number; clawed_back_cents: number | null; status: string; save_type: string | null }>(
      `select l.save_id, l.amount_cents, l.clawed_back_cents, l.status, s.type as save_type
         from save_fee_lines l
         left join saves s on s.id = l.save_id
        where l.account_id = $1 and l.billing_month = $2`,
      [accountId, billingMonth],
    ),
  ]);

  const ids = caseRows.map((c) => c.id);
  const [emails, saves] = ids.length
    ? await Promise.all([
        load<DunningCaseView["emails"][number] & { dunning_case_id: string }>(
          `select dunning_case_id, step, status, sent_at, opened_at, clicked_at from dunning_emails
            where account_id = $1 and dunning_case_id = any($2)
            order by step asc`,
          [accountId, ids],
        ),
        load<{ dunning_case_id: string; fee_cents: number }>(
          "select dunning_case_id, fee_cents from saves where account_id = $1 and type = 'dunning' and dunning_case_id = any($2)",
          [accountId, ids],
        ),
      ])
    : [[], []];

  type EmailRow = DunningCaseView["emails"][number] & { dunning_case_id: string };
  const emailsByCase = new Map<string, DunningCaseView["emails"]>();
  for (const e of emails as EmailRow[]) {
    const list = emailsByCase.get(e.dunning_case_id) ?? [];
    list.push({ step: e.step, status: e.status, sent_at: e.sent_at, opened_at: e.opened_at, clicked_at: e.clicked_at });
    emailsByCase.set(e.dunning_case_id, list);
  }
  const feeByCase = new Map<string, number>();
  for (const s of saves) feeByCase.set(s.dunning_case_id, Number(s.fee_cents));

  const lines: FeeLine[] = feeLines.map((r) => {
    return {
      saveId: r.save_id,
      kind: r.save_type === "dunning" ? "dunning" : "cancel",
      amountCents: Number(r.amount_cents),
      clawedBack: r.status === "clawed_back",
      clawedBackCents: Number(r.clawed_back_cents ?? 0),
    };
  });

  return {
    settings: settingsFromRow(settings),
    hasSettingsRow: !!settings,
    openCount: open.length,
    openAmountCents: open.reduce((a, r) => a + Number(r.amount_due_cents ?? 0), 0),
    recoveredThisMonthCents: recoveredRows.reduce((a, r) => a + Number(r.recovered_amount_cents ?? 0), 0),
    recoveredByUnquitThisMonthCents: recoveredRows
      .filter((r) => r.recovered_via === "update_link" || r.recovered_via === "unquit_retry")
      .reduce((a, r) => a + Number(r.recovered_amount_cents ?? 0), 0),
    dunningFeesThisMonthCents: lines
      .filter((l) => l.kind === "dunning" && !l.clawedBack)
      .reduce((a, l) => a + l.amountCents - Math.min(l.amountCents, l.clawedBackCents ?? 0), 0),
    bill: calculateMonthlyBill(lines),
    cases: caseRows.map((c) => ({ ...c, emails: emailsByCase.get(c.id) ?? [], feeCents: feeByCase.get(c.id) ?? 0 })),
  };
}
