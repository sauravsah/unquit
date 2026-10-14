/**
 * unquit's own revenue: one Stripe Invoice per founder per month, on the
 * PLATFORM Stripe account (never the founder's connected account).
 *
 * On the 1st (Vercel Cron) each founder's previous month is billed:
 *   1. claim the (account, month) row in billing_periods: unique, so a
 *      second run, a retry or the daily catch-up never bills twice
 *   2. assign the month's billable fee lines to it (verified, not held,
 *      not yet billed; lines released from a hold later join the next month)
 *   3. build the statement (lib/billing/statement.ts): cap + earlier credits
 *   4. $0 -> status "zero": no invoice, the statement is still shown
 *      > $0 -> create a draft invoice, add invoice items (cancel saves,
 *      dunning recoveries, the cap, credits), finalize it, store the links
 *
 * A run that crashes half way is safe to repeat: the period row is locked
 * while a run works on it, the invoice id is saved the moment it exists, a
 * leftover draft is deleted and rebuilt, and every Stripe write carries an
 * idempotency key derived from the period id and attempt.
 */
import { formatCents, MONTHLY_FEE_CAP_CENTS, OVERLAP_RECOVERY_LABEL } from "@/lib/pricing";
import { monthKey, monthLabel, monthSlug, previousMonthKey } from "@/lib/ledger/fees";
import { buildStatement, creditOwedCents, type Statement, type StatementLine } from "./statement";

export type PeriodStatus = "building" | "invoiced" | "closed" | "zero" | "failed";

export type PeriodRow = {
  id: string;
  account_id: string;
  period_month: string;
  status: PeriodStatus;
  cancel_fees_cents: number;
  cancel_lines_count: number;
  dunning_fees_cents: number;
  dunning_lines_count: number;
  clawed_back_cents: number;
  gross_cents: number;
  cap_cents: number;
  cap_discount_cents: number;
  capped_cents: number;
  credit_applied_cents: number;
  total_cents: number;
  stripe_invoice_id: string | null;
  hosted_invoice_url: string | null;
  invoice_pdf_url: string | null;
  invoice_status: string | null;
  attempts: number;
  locked_at: string | null;
  error: string | null;
  computed_at: string | null;
  finalized_at: string | null;
  created_at: string;
  carried_in_cents: number;
  amount_due_cents: number;
  carried_to_period_id: string | null;
  payment_status: string | null;
};

export const PERIOD_COLUMNS =
  "id, account_id, period_month, status, cancel_fees_cents, cancel_lines_count, dunning_fees_cents, dunning_lines_count, clawed_back_cents, gross_cents, cap_cents, cap_discount_cents, capped_cents, credit_applied_cents, total_cents, stripe_invoice_id, hosted_invoice_url, invoice_pdf_url, invoice_status, attempts, locked_at, error, computed_at, finalized_at, created_at, carried_in_cents, amount_due_cents, carried_to_period_id, payment_status";

export type BillingAccount = {
  id: string;
  name: string | null;
  email: string | null;
  platform_customer_id: string | null;
  billing_pm_status: "none" | "active";
};

export interface BillingRepo {
  /** Accounts that need a statement for `month`: connected before it ended, or with unbilled lines up to it. */
  accountsToBill(month: string): Promise<string[]>;
  getBillingAccount(accountId: string): Promise<BillingAccount | null>;
  /** Saves the customer id if none is set yet; returns the one stored. */
  setPlatformCustomer(accountId: string, customerId: string): Promise<string>;
  getPeriod(accountId: string, month: string): Promise<PeriodRow | null>;
  /** Insert-if-missing (unique account+month). */
  ensurePeriod(accountId: string, month: string, capCents: number): Promise<PeriodRow>;
  /** Compare-and-set lock: building/failed and not locked (or lock older than `staleBefore`). */
  lockPeriod(periodId: string, at: string, staleBefore: string): Promise<PeriodRow | null>;
  /** Unbilled, unheld, not fully clawed lines with billing_month <= month -> this period. */
  assignLines(accountId: string, periodId: string, month: string, at: string): Promise<void>;
  linesForPeriod(periodId: string): Promise<StatementLine[]>;
  /** invoiced / zero periods of the account other than `exceptPeriodId`. */
  closedPeriods(accountId: string, exceptPeriodId: string): Promise<PeriodRow[]>;
  updatePeriod(periodId: string, fields: Partial<PeriodRow>): Promise<void>;
}

export type InvoiceSummary = {
  id: string;
  status: string | null;
  hostedInvoiceUrl: string | null;
  invoicePdf: string | null;
  totalCents: number;
};

export interface BillingStripe {
  createCustomer(input: { accountId: string; email: string | null; name: string | null }, idempotencyKey: string): Promise<string>;
  createInvoice(
    input: {
      customerId: string;
      collection: "charge_automatically" | "send_invoice";
      description: string;
      footer: string;
      metadata: Record<string, string>;
    },
    idempotencyKey: string,
  ): Promise<{ id: string }>;
  addInvoiceItem(
    input: { customerId: string; invoiceId: string; amountCents: number; description: string; metadata: Record<string, string> },
    idempotencyKey: string,
  ): Promise<void>;
  finalizeInvoice(invoiceId: string, idempotencyKey: string): Promise<InvoiceSummary>;
  getInvoice(invoiceId: string): Promise<InvoiceSummary | null>;
  deleteDraftInvoice(invoiceId: string): Promise<void>;
}

/**
 * Collects closed statements with an automatic card charge (Dodo Payments,
 * lib/billing/dodo/service.ts) instead of a Stripe invoice.
 */
export interface ChargeCollector {
  /** Rolls earlier below-minimum statements into this one; returns the amount carried in. Idempotent per period. */
  claimCarryIn(accountId: string, periodId: string): Promise<number>;
  /** Creates this statement's single charge (or corrects its amount before any attempt). */
  scheduleCharge(input: { accountId: string; periodId: string; amountCents: number; at: string }): Promise<void>;
  /** Amounts below this are carried forward to the next statement. */
  minChargeCents: number;
}

export type BillingDeps = {
  repo: BillingRepo;
  /** Legacy: a Stripe invoice per statement. Used only when no `collector` is set. */
  stripe?: BillingStripe;
  /** Automatic card charges through Dodo Payments (production). */
  collector?: ChargeCollector;
  appUrl: string;
  capCents?: number;
  now?: () => Date;
  log?: (line: string) => void;
};

export type BillOutcome =
  | { outcome: "invoiced"; periodId: string; totalCents: number; invoiceId: string }
  | { outcome: "zero"; periodId: string }
  | { outcome: "closed"; periodId: string; amountDueCents: number; payment: "scheduled" | "carried_forward" }
  | { outcome: "already_done"; periodId: string; status: PeriodStatus }
  | { outcome: "locked"; periodId: string }
  | { outcome: "failed"; periodId: string | null; error: string };

const LOCK_STALE_MS = 10 * 60_000;

export const statementUrl = (appUrl: string, month: string) => `${appUrl}/dashboard/billing/${monthSlug(month)}`;

/** The month a run on `now` bills: the previous calendar month (UTC). */
export function monthToBill(now: Date): string {
  return previousMonthKey(monthKey(now));
}

function periodFields(s: Statement): Partial<PeriodRow> {
  return {
    cancel_fees_cents: s.cancelFeesCents,
    cancel_lines_count: s.cancelLinesCount,
    dunning_fees_cents: s.dunningFeesCents,
    dunning_lines_count: s.dunningLinesCount,
    clawed_back_cents: s.clawedBackCents,
    gross_cents: s.grossCents,
    cap_cents: s.capCents,
    cap_discount_cents: s.capDiscountCents,
    capped_cents: s.cappedCents,
    credit_applied_cents: s.creditAppliedCents,
    total_cents: s.totalCents,
  };
}

/** The invoice items for a statement (negative amounts are credits). */
export function invoiceItemsFor(s: Statement, month: string): { key: string; amountCents: number; description: string }[] {
  const label = monthLabel(month);
  const items: { key: string; amountCents: number; description: string }[] = [];
  if (s.cancelFeesCents > 0) {
    items.push({
      key: "cancel",
      amountCents: s.cancelFeesCents,
      description: `Cancel saves, ${label}: ${s.cancelLinesCount} paid month${s.cancelLinesCount === 1 ? "" : "s"} × 20% of saved MRR`,
    });
  }
  const fullDunningCents = s.dunningFeesCents - (s.overlapDunningFeesCents ?? 0);
  const fullDunningCount = s.dunningLinesCount - (s.overlapDunningLinesCount ?? 0);
  if (fullDunningCents > 0) {
    items.push({
      key: "dunning",
      amountCents: fullDunningCents,
      description: `Failed-payment recoveries, ${label}: ${fullDunningCount} × 10% of the recovered amount`,
    });
  }
  if ((s.overlapDunningFeesCents ?? 0) > 0) {
    items.push({
      key: "dunning_overlap",
      amountCents: s.overlapDunningFeesCents,
      description: `${OVERLAP_RECOVERY_LABEL}, ${label}: ${s.overlapDunningLinesCount} × 5% of the recovered amount`,
    });
  }
  if (s.capDiscountCents > 0) {
    items.push({ key: "cap", amountCents: -s.capDiscountCents, description: `Monthly cap: you never pay more than ${formatCents(s.capCents)}` });
  }
  if (s.creditAppliedCents > 0) {
    items.push({ key: "credit", amountCents: -s.creditAppliedCents, description: "Credit: refunds and disputes on fees billed in earlier months" });
  }
  return items;
}

async function computeStatement(deps: BillingDeps, period: PeriodRow, capCents: number): Promise<Statement> {
  const lines = await deps.repo.linesForPeriod(period.id);
  const closed = await deps.repo.closedPeriods(period.account_id, period.id);
  const closedWithLines = await Promise.all(
    closed.map(async (p) => ({
      id: p.id,
      cappedCents: Number(p.capped_cents),
      capCents: Number(p.cap_cents),
      creditAppliedCents: Number(p.credit_applied_cents),
      lines: await deps.repo.linesForPeriod(p.id),
    })),
  );
  return buildStatement(lines, creditOwedCents(closedWithLines), capCents);
}

/** Makes sure the founder has a Customer on unquit's own Stripe account. */
export async function ensurePlatformCustomer(
  repo: Pick<BillingRepo, "getBillingAccount" | "setPlatformCustomer">,
  stripe: Pick<BillingStripe, "createCustomer">,
  accountId: string,
): Promise<string> {
  const account = await repo.getBillingAccount(accountId);
  if (!account) throw new Error(`Account ${accountId} not found`);
  if (account.platform_customer_id) return account.platform_customer_id;
  const id = await stripe.createCustomer({ accountId, email: account.email, name: account.name }, `unquit_customer_${accountId}`);
  return repo.setPlatformCustomer(accountId, id);
}

/**
 * Dodo mode: closes the statement and hands it to the collector. The amount
 * due is this month's total (fees after clawbacks, the $299 cap and earlier
 * credits; a credit larger than the fees carries forward through
 * creditOwedCents, never paid out) plus small amounts carried in from
 * earlier statements. Below the minimum charge it is carried forward again.
 */
async function closeForCollection(
  deps: BillingDeps,
  collector: ChargeCollector,
  period: PeriodRow,
  accountId: string,
  month: string,
  now: Date,
  capCents: number,
): Promise<BillOutcome> {
  try {
    await deps.repo.assignLines(accountId, period.id, month, now.toISOString());
    const statement = await computeStatement(deps, period, capCents);
    const carriedIn = await collector.claimCarryIn(accountId, period.id);
    const amountDue = statement.totalCents + carriedIn;
    const fields = { ...periodFields(statement), carried_in_cents: carriedIn, amount_due_cents: amountDue, computed_at: now.toISOString() };

    if (amountDue === 0) {
      await deps.repo.updatePeriod(period.id, { ...fields, status: "zero", payment_status: null, finalized_at: now.toISOString(), locked_at: null, error: null });
      return { outcome: "zero", periodId: period.id };
    }
    if (amountDue < collector.minChargeCents) {
      await deps.repo.updatePeriod(period.id, { ...fields, status: "closed", payment_status: "carried_forward", finalized_at: now.toISOString(), locked_at: null, error: null });
      return { outcome: "closed", periodId: period.id, amountDueCents: amountDue, payment: "carried_forward" };
    }
    // The charge row first, then the status: a crash in between leaves a period
    // the next run re-closes with the same (or corrected) amount.
    await deps.repo.updatePeriod(period.id, fields);
    await collector.scheduleCharge({ accountId, periodId: period.id, amountCents: amountDue, at: now.toISOString() });
    await deps.repo.updatePeriod(period.id, { status: "closed", payment_status: "scheduled", finalized_at: now.toISOString(), locked_at: null, error: null });
    return { outcome: "closed", periodId: period.id, amountDueCents: amountDue, payment: "scheduled" };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await deps.repo.updatePeriod(period.id, { status: "failed", error: message.slice(0, 2000), locked_at: null });
    deps.log?.(`[billing] ${accountId} ${month} failed: ${message}`);
    return { outcome: "failed", periodId: period.id, error: message };
  }
}

/** Bills one founder for one month. Idempotent. */
export async function billAccountForMonth(deps: BillingDeps, accountId: string, month: string): Promise<BillOutcome> {
  const now = deps.now?.() ?? new Date();
  const capCents = deps.capCents ?? MONTHLY_FEE_CAP_CENTS;
  let period = await deps.repo.ensurePeriod(accountId, month, capCents);
  if (period.status === "invoiced" || period.status === "zero" || period.status === "closed") return { outcome: "already_done", periodId: period.id, status: period.status };

  const locked = await deps.repo.lockPeriod(period.id, now.toISOString(), new Date(now.getTime() - LOCK_STALE_MS).toISOString());
  if (!locked) {
    const latest = await deps.repo.getPeriod(accountId, month);
    if (latest && (latest.status === "invoiced" || latest.status === "zero" || latest.status === "closed")) {
      return { outcome: "already_done", periodId: latest.id, status: latest.status };
    }
    return { outcome: "locked", periodId: period.id };
  }
  period = locked;
  const attempt = period.attempts;

  if (deps.collector) return closeForCollection(deps, deps.collector, period, accountId, month, now, capCents);
  if (!deps.stripe) throw new Error("Billing needs a collector (Dodo) or a Stripe client");
  const stripe = deps.stripe;

  try {
    // A previous attempt got as far as creating an invoice.
    if (period.stripe_invoice_id) {
      const existing = await stripe.getInvoice(period.stripe_invoice_id);
      if (existing && existing.status && existing.status !== "draft") {
        await deps.repo.updatePeriod(period.id, {
          status: "invoiced",
          invoice_status: existing.status,
          hosted_invoice_url: existing.hostedInvoiceUrl,
          invoice_pdf_url: existing.invoicePdf,
          finalized_at: period.finalized_at ?? now.toISOString(),
          locked_at: null,
          error: null,
        });
        return { outcome: "invoiced", periodId: period.id, totalCents: Number(period.total_cents), invoiceId: existing.id };
      }
      if (existing) await stripe.deleteDraftInvoice(existing.id);
      await deps.repo.updatePeriod(period.id, { stripe_invoice_id: null });
    }

    await deps.repo.assignLines(accountId, period.id, month, now.toISOString());
    const statement = await computeStatement(deps, period, capCents);
    await deps.repo.updatePeriod(period.id, { ...periodFields(statement), computed_at: now.toISOString() });

    if (statement.totalCents === 0) {
      await deps.repo.updatePeriod(period.id, { status: "zero", finalized_at: now.toISOString(), locked_at: null, error: null });
      return { outcome: "zero", periodId: period.id };
    }

    const customerId = await ensurePlatformCustomer(deps.repo, stripe, accountId);
    const account = await deps.repo.getBillingAccount(accountId);
    const key = `unquit_bill_${period.id}_${attempt}`;
    const url = statementUrl(deps.appUrl, month);
    const metadata = { unquit_account_id: accountId, unquit_period: monthSlug(month), unquit_period_id: period.id };

    const invoice = await stripe.createInvoice(
      {
        customerId,
        // With a saved card Stripe charges it; without one Stripe emails the invoice to pay online.
        collection: account?.billing_pm_status === "active" ? "charge_automatically" : "send_invoice",
        description: `unquit fees for ${monthLabel(month)}. Itemised statement: ${url}`,
        footer: `Statement with every save and receipt: ${url}`,
        metadata,
      },
      `${key}_invoice`,
    );
    await deps.repo.updatePeriod(period.id, { stripe_invoice_id: invoice.id });

    for (const item of invoiceItemsFor(statement, month)) {
      await stripe.addInvoiceItem(
        { customerId, invoiceId: invoice.id, amountCents: item.amountCents, description: item.description, metadata: { ...metadata, line: item.key } },
        `${key}_item_${item.key}`,
      );
    }

    // Never finalize an invoice that doesn't match the statement (e.g. a tax
    // setting on the platform account). The draft is rebuilt on the next run.
    const draft = await stripe.getInvoice(invoice.id);
    if (!draft || draft.totalCents !== statement.totalCents) {
      throw new Error(`Stripe draft total ${draft?.totalCents ?? "missing"} doesn't match the statement ${statement.totalCents}`);
    }
    const finalized = await stripe.finalizeInvoice(invoice.id, `${key}_finalize`);
    await deps.repo.updatePeriod(period.id, {
      status: "invoiced",
      invoice_status: finalized.status,
      hosted_invoice_url: finalized.hostedInvoiceUrl,
      invoice_pdf_url: finalized.invoicePdf,
      finalized_at: now.toISOString(),
      locked_at: null,
      error: null,
    });
    return { outcome: "invoiced", periodId: period.id, totalCents: statement.totalCents, invoiceId: invoice.id };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await deps.repo.updatePeriod(period.id, { status: "failed", error: message.slice(0, 2000), locked_at: null });
    deps.log?.(`[billing] ${accountId} ${month} failed: ${message}`);
    return { outcome: "failed", periodId: period.id, error: message };
  }
}

export type BillingRunSummary = { month: string; accounts: number } & Partial<Record<BillOutcome["outcome"], number>>;

/** Bills every founder for `month` (default: last month). Safe to run again. */
export async function runMonthlyBilling(deps: BillingDeps, options: { month?: string } = {}): Promise<BillingRunSummary> {
  const now = deps.now?.() ?? new Date();
  const month = options.month ?? monthToBill(now);
  if (month >= monthKey(now)) throw new Error(`Refusing to bill ${month}: the month hasn't ended yet`);
  const accounts = await deps.repo.accountsToBill(month);
  const summary: BillingRunSummary = { month, accounts: accounts.length };
  for (const accountId of accounts) {
    let result: BillOutcome;
    try {
      result = await billAccountForMonth(deps, accountId, month);
    } catch (error) {
      result = { outcome: "failed", periodId: null, error: error instanceof Error ? error.message : String(error) };
      deps.log?.(`[billing] ${accountId} crashed: ${result.error}`);
    }
    summary[result.outcome] = (summary[result.outcome] ?? 0) + 1;
  }
  return summary;
}

/**
 * The running total for the month in progress (the billing page and the
 * overview card): unbilled, unheld lines up to this month, with the cap and
 * any credit owed from earlier statements.
 */
export function runningStatement(lines: readonly StatementLine[], creditOwed: number, capCents = MONTHLY_FEE_CAP_CENTS): Statement {
  return buildStatement(lines, creditOwed, capCents);
}
