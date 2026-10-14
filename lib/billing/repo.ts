import "server-only";
import { attempt, insertStatement, queryOne, run, updateStatement, type Db } from "@/lib/db/core";
import type { StatementLine } from "./statement";
import { PERIOD_COLUMNS, type BillingAccount, type BillingRepo, type PeriodRow } from "./service";

type LineJoin = {
  id: string;
  save_id: string;
  amount_cents: number;
  clawed_back_cents: number;
  save_type: "cancel" | "dunning" | null;
  overlap_save_id?: string | null;
};

export function toStatementLine(row: LineJoin): StatementLine {
  return {
    id: row.id,
    saveId: row.save_id,
    kind: row.save_type === "dunning" ? "dunning" : "cancel",
    amountCents: Number(row.amount_cents),
    clawedBackCents: Number(row.clawed_back_cents ?? 0),
    overlap: !!row.overlap_save_id,
  };
}

/** Fee lines with their save's type (inner join: a line always has a save). */
export const STATEMENT_LINE_SELECT =
  "select l.id, l.save_id, l.amount_cents, l.clawed_back_cents, l.overlap_save_id, s.type as save_type from save_fee_lines l join saves s on s.id = l.save_id";

/** The owner's sign-in email. */
export async function ownerEmail(db: Db, ownerUserId: string): Promise<string | null> {
  try {
    const row = await queryOne<{ email: string }>(db, "select email from users where id = $1", [ownerUserId]);
    return row?.email ?? null;
  } catch {
    return null;
  }
}

/** Billing's database side (the cron and server routes only). */
export function createBillingRepo(db: Db): BillingRepo {
  return {
    async accountsToBill(month) {
      const [y, m] = month.split("-").map(Number) as [number, number];
      const nextMonth = new Date(Date.UTC(y, m, 1)).toISOString();
      const rows = await attempt("Loading accounts to bill", () =>
        db.query<{ id: string }>(
          `select id from accounts where stripe_connection_status = 'connected' and stripe_connected_at < $1
           union
           select account_id as id from save_fee_lines where billing_period_id is null and status = 'earned' and billing_month <= $2`,
          [nextMonth, month],
        ),
      );
      return [...new Set(rows.map((r) => r.id))];
    },

    async getBillingAccount(accountId): Promise<BillingAccount | null> {
      const data = await attempt("Loading account", () =>
        queryOne<{ id: string; name: string | null; owner_user_id: string; platform_customer_id: string | null; billing_pm_status: "none" | "active" }>(
          db,
          "select id, name, owner_user_id, platform_customer_id, billing_pm_status from accounts where id = $1",
          [accountId],
        ),
      );
      if (!data) return null;
      return {
        id: data.id,
        name: data.name ?? null,
        email: await ownerEmail(db, data.owner_user_id),
        platform_customer_id: data.platform_customer_id ?? null,
        billing_pm_status: data.billing_pm_status ?? "none",
      };
    },

    async setPlatformCustomer(accountId, customerId) {
      // First writer wins; everyone reads back the stored id.
      await attempt("Saving platform customer", () =>
        db.query("update accounts set platform_customer_id = $2 where id = $1 and platform_customer_id is null", [accountId, customerId]),
      );
      const row = await attempt("Loading platform customer", () =>
        queryOne<{ platform_customer_id: string | null }>(db, "select platform_customer_id from accounts where id = $1", [accountId]),
      );
      if (!row?.platform_customer_id) throw new Error(`Loading platform customer failed: account ${accountId} has none`);
      return row.platform_customer_id;
    },

    async getPeriod(accountId, month) {
      return attempt("Loading billing period", () =>
        queryOne<PeriodRow>(db, `select ${PERIOD_COLUMNS} from billing_periods where account_id = $1 and period_month = $2`, [accountId, month]),
      );
    },

    async ensurePeriod(accountId, month, capCents) {
      await attempt("Claiming billing period", () =>
        run(
          db,
          insertStatement(
            "billing_periods",
            { account_id: accountId, period_month: month, cap_cents: capCents },
            { onConflictDoNothing: "account_id, period_month" },
          ),
        ),
      );
      const period = await this.getPeriod(accountId, month);
      if (!period) throw new Error(`Billing period ${accountId} ${month} vanished`);
      return period;
    },

    async lockPeriod(periodId, at, staleBefore) {
      // Compare-and-set on attempts, only for a period that is not locked by a live run.
      const rows = await attempt("Locking billing period", () =>
        db.query<PeriodRow>(
          `update billing_periods
              set locked_at = $2, attempts = attempts + 1, status = 'building'
            where id = $1
              and status in ('building', 'failed')
              and (locked_at is null or locked_at < $3)
            returning ${PERIOD_COLUMNS}`,
          [periodId, at, staleBefore],
        ),
      );
      return rows[0] ?? null;
    },

    async assignLines(accountId, periodId, month, at) {
      await attempt("Assigning fee lines", () =>
        db.query(
          `update save_fee_lines
              set billing_period_id = $2, status = 'billed', billed_at = $4
            where account_id = $1
              and billing_period_id is null
              and status = 'earned'
              and billing_month <= $3
              and held_stripe_dispute_id is null
              and held_founder_dispute_id is null`,
          [accountId, periodId, month, at],
        ),
      );
    },

    async linesForPeriod(periodId) {
      const rows = await attempt("Loading statement lines", () => db.query<LineJoin>(`${STATEMENT_LINE_SELECT} where l.billing_period_id = $1`, [periodId]));
      return rows.map(toStatementLine);
    },

    async closedPeriods(accountId, exceptPeriodId) {
      return attempt("Loading billing periods", () =>
        db.query<PeriodRow>(
          `select ${PERIOD_COLUMNS} from billing_periods
            where account_id = $1 and status in ('invoiced', 'closed', 'zero') and id <> $2
            order by period_month asc`,
          [accountId, exceptPeriodId],
        ),
      );
    },

    async updatePeriod(periodId, fields) {
      await attempt("Updating billing period", () => run(db, updateStatement("billing_periods", fields as Record<string, unknown>, { id: periodId })));
    },
  };
}
