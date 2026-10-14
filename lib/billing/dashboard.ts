import "server-only";
import { attempt, queryOne, type Db } from "@/lib/db/core";
import { chargesForAccount, type ChargeView } from "./dodo/service";
import { PERIOD_COLUMNS, type PeriodRow } from "./service";

export type BillingAccountView = {
  billing_pm_status: "none" | "active";
  billing_pm_brand: string | null;
  billing_pm_last4: string | null;
  billing_pm_updated_at: string | null;
  dodo_subscription_id: string | null;
  dodo_subscription_status: string | null;
  dodo_mandate_at: string | null;
};

/** The founder's own statements, charges and card status (scoped to their account id). */
export async function loadBillingPage(
  db: Db,
  accountId: string,
): Promise<{ account: BillingAccountView; periods: PeriodRow[]; charges: ChargeView[]; carriedForwardCents: number }> {
  const [account, periods, charges] = await Promise.all([
    attempt("Loading billing", () =>
      queryOne<BillingAccountView>(
        db,
        `select billing_pm_status, billing_pm_brand, billing_pm_last4, billing_pm_updated_at,
                dodo_subscription_id, dodo_subscription_status, dodo_mandate_at
           from accounts where id = $1`,
        [accountId],
      ),
    ),
    attempt("Loading statements", () =>
      db.query<PeriodRow>(`select ${PERIOD_COLUMNS} from billing_periods where account_id = $1 order by period_month desc limit 36`, [accountId]),
    ),
    chargesForAccount(db, accountId),
  ]);
  if (!account) throw new Error("Loading billing failed: account not found");
  // Small statements waiting to be added to the next charge.
  const carriedForwardCents = periods
    .filter((p) => p.payment_status === "carried_forward" && !p.carried_to_period_id)
    .reduce((a, p) => a + Number(p.amount_due_cents), 0);
  return { account, periods, charges, carriedForwardCents };
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

type FlatLine = Omit<StatementLineView, "saves"> & {
  save_receipt_number: string;
  save_type: "cancel" | "dunning";
  save_customer_email: string | null;
  save_stripe_customer_id: string;
};

const LINE_SELECT = `select l.id, l.month_index, l.billing_month, l.amount_cents, l.clawed_back_cents, l.stripe_invoice_id,
       s.receipt_number as save_receipt_number, s.type as save_type, s.customer_email as save_customer_email,
       s.stripe_customer_id as save_stripe_customer_id
  from save_fee_lines l
  join saves s on s.id = l.save_id`;

function toView(r: FlatLine): StatementLineView {
  const { save_receipt_number, save_type, save_customer_email, save_stripe_customer_id, ...line } = r;
  return {
    ...line,
    saves: { receipt_number: save_receipt_number, type: save_type, customer_email: save_customer_email, stripe_customer_id: save_stripe_customer_id },
  };
}

export async function loadStatement(db: Db, accountId: string, month: string): Promise<{ period: PeriodRow | null; lines: StatementLineView[] }> {
  const period = await attempt("Loading statement", () =>
    queryOne<PeriodRow>(db, `select ${PERIOD_COLUMNS} from billing_periods where account_id = $1 and period_month = $2`, [accountId, month]),
  );
  const lines = await attempt("Loading statement", () =>
    period
      ? db.query<FlatLine>(`${LINE_SELECT} where l.account_id = $1 and l.billing_period_id = $2 order by l.billing_month asc`, [accountId, period.id])
      : db.query<FlatLine>(
          `${LINE_SELECT}
            where l.account_id = $1 and l.billing_period_id is null and l.status = 'earned' and l.billing_month <= $2
              and l.held_stripe_dispute_id is null and l.held_founder_dispute_id is null
            order by l.billing_month asc`,
          [accountId, month],
        ),
  );
  return { period, lines: lines.map(toView) };
}
