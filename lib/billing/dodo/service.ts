/**
 * unquit's own fees, collected automatically through Dodo Payments (merchant
 * of record) with an ON-DEMAND subscription per founder.
 *
 *   1. Billing method: the founder saves a card once in a Dodo checkout that
 *      creates an on-demand subscription with `mandate_only: true` (nothing is
 *      charged). Replacing the card uses update-payment-method.
 *   2. Statements close on the 1st (lib/billing/service.ts). A statement whose
 *      amount due is at least MIN_CHARGE_CENTS gets ONE billing_charges row
 *      (unique per statement); smaller amounts carry forward.
 *   3. chargeDue() charges due rows with POST /subscriptions/{id}/charge.
 *      Each attempt is claimed with a compare-and-set before the request is
 *      sent, and at most one attempt per charge can be in flight, so a cron
 *      retry or two overlapping runs can never double-charge.
 *   4. Webhooks (payment.succeeded / payment.failed / refund.succeeded /
 *      subscription.*) settle attempts; failures follow Dodo's safe retry
 *      policy (lib/billing/dodo/policy.ts): +3, +10, +17 days anchored to the
 *      first attempt, hard declines never retried, then "unpaid" + an email.
 *
 * TODO(billing): an unpaid statement does NOT pause the founder's product
 * features. Saurav hasn't decided whether it should. `hasUnpaidStatement()`
 * is the flag to build that on; nothing reads it for enforcement today.
 */
import { attempt, isUniqueViolation, queryOne, type Db } from "@/lib/db/core";
import type { RenderedEmail } from "@/lib/ledger/emails";
import { monthLabel, monthSlug } from "@/lib/ledger/fees";
import { DodoApiError, parsePayment, parseSubscription, type DodoClient, type DodoPayment, type DodoSubscription } from "./client";
import { addCardEmail, paymentFailedEmail, paymentUnpaidEmail } from "./emails";
import { afterFailure, DUE_SLACK_MS, founderDeclineMessage, isHardDecline, MAX_TOTAL_ATTEMPTS } from "./policy";

export type FounderNotifier = {
  toFounder(accountId: string, email: RenderedEmail & { idempotencyKey: string }): Promise<boolean>;
};

export type DodoBillingDeps = {
  db: Db;
  dodo: DodoClient;
  /** The Dodo subscription product "Unquit usage fees" (DODO_USAGE_PRODUCT_ID). */
  productId: string;
  appUrl: string;
  mailer?: FounderNotifier;
  now?: () => Date;
  log?: (line: string) => void;
};

/** Subscription statuses that can still be charged on demand (on_hold is a signal, not a lock). */
const CHARGEABLE = new Set(["active", "on_hold", "past_due"]);
export const isChargeable = (status: string | null | undefined) => !!status && CHARGEABLE.has(status);

export type ChargeStatus = "scheduled" | "awaiting_card" | "processing" | "retrying" | "paid" | "unpaid" | "refunded" | "partially_refunded";

export type ChargeRow = {
  id: string;
  account_id: string;
  billing_period_id: string;
  amount_cents: number;
  currency: string;
  status: ChargeStatus;
  attempts_count: number;
  cycle_started_at: string | null;
  cycle_attempts: number;
  next_attempt_at: string | null;
  dodo_subscription_id: string | null;
  dodo_payment_id: string | null;
  last_error_code: string | null;
  last_error_message: string | null;
  hard_declined: boolean;
  receipt_url: string | null;
  refunded_cents: number;
  paid_at: string | null;
  unpaid_at: string | null;
  failure_emailed_at: string | null;
  unpaid_emailed_at: string | null;
  created_at: string;
  updated_at: string;
};

export const CHARGE_COLUMNS =
  "id, account_id, billing_period_id, amount_cents, currency, status, attempts_count, cycle_started_at, cycle_attempts, next_attempt_at, dodo_subscription_id, dodo_payment_id, last_error_code, last_error_message, hard_declined, receipt_url, refunded_cents, paid_at, unpaid_at, failure_emailed_at, unpaid_emailed_at, created_at, updated_at";

export type AttemptRow = {
  id: string;
  charge_id: string;
  attempt_no: number;
  state: "sending" | "processing" | "succeeded" | "failed" | "not_created";
  amount_cents: number;
  dodo_payment_id: string | null;
  error_code: string | null;
  error_message: string | null;
  sent_at: string;
  resolved_at: string | null;
};

const ATTEMPT_COLUMNS = "id, charge_id, attempt_no, state, amount_cents, dodo_payment_id, error_code, error_message, sent_at, resolved_at";

export type BillingMethod = {
  id: string;
  name: string | null;
  owner_user_id: string;
  dodo_customer_id: string | null;
  dodo_subscription_id: string | null;
  dodo_subscription_status: string | null;
  dodo_status_at: string | null;
  dodo_mandate_at: string | null;
  billing_pm_brand: string | null;
  billing_pm_last4: string | null;
};

const METHOD_COLUMNS =
  "id, name, owner_user_id, dodo_customer_id, dodo_subscription_id, dodo_subscription_status, dodo_status_at, dodo_mandate_at, billing_pm_brand, billing_pm_last4";

const nowOf = (deps: { now?: () => Date }) => deps.now?.() ?? new Date();
const billingUrl = (appUrl: string) => `${appUrl}/dashboard/billing`;

async function loadMethod(db: Db, accountId: string): Promise<BillingMethod | null> {
  return attempt("Loading billing method", () => queryOne<BillingMethod>(db, `select ${METHOD_COLUMNS} from accounts where id = $1`, [accountId]));
}

async function ownerEmailOf(db: Db, ownerUserId: string): Promise<string | null> {
  const row = await queryOne<{ email: string }>(db, "select email from users where id = $1", [ownerUserId]).catch(() => null);
  return row?.email ?? null;
}

async function loadCharge(db: Db, chargeId: string): Promise<ChargeRow | null> {
  return attempt("Loading charge", () => queryOne<ChargeRow>(db, `select ${CHARGE_COLUMNS} from billing_charges where id = $1`, [chargeId]));
}

/** Mirrors the charge's status onto its statement (billing_periods.payment_status). */
async function syncPeriod(db: Db, chargeId: string): Promise<void> {
  await attempt("Updating statement payment status", () =>
    db.query(
      `update billing_periods p set payment_status = c.status
         from billing_charges c
        where c.id = $1 and p.id = c.billing_period_id and p.payment_status is distinct from c.status`,
      [chargeId],
    ),
  );
}

async function periodMonth(db: Db, periodId: string): Promise<string | null> {
  const row = await queryOne<{ period_month: string }>(db, "select period_month from billing_periods where id = $1", [periodId]).catch(() => null);
  return row?.period_month ?? null;
}

/** Best-effort founder email: never fails the caller (Resend may not be configured). */
async function notify(deps: DodoBillingDeps, accountId: string, email: RenderedEmail, idempotencyKey: string): Promise<boolean> {
  if (!deps.mailer) return false;
  try {
    return await deps.mailer.toFounder(accountId, { ...email, idempotencyKey });
  } catch (error) {
    deps.log?.(`[billing/dodo] email to founder ${accountId} failed (ignored): ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}

// -----------------------------------------------------------------------------
// 1. Billing method
// -----------------------------------------------------------------------------

export type StartResult = { url: string; kind: "checkout" | "update_payment_method" };

/**
 * Where to send the founder to save (or replace) their card: a Dodo checkout
 * creating an on-demand mandate, or Dodo's update-payment-method page when a
 * chargeable subscription already exists.
 */
export async function startBillingMethod(deps: DodoBillingDeps, accountId: string): Promise<StartResult> {
  const method = await loadMethod(deps.db, accountId);
  if (!method) throw new Error(`Account ${accountId} not found`);
  const base = billingUrl(deps.appUrl);

  if (method.dodo_subscription_id && isChargeable(method.dodo_subscription_status)) {
    try {
      const res = await deps.dodo.updatePaymentMethod(method.dodo_subscription_id, `${base}?card=updated&subscription_id=${encodeURIComponent(method.dodo_subscription_id)}`);
      if (res.paymentLink) return { url: res.paymentLink, kind: "update_payment_method" };
    } catch (error) {
      // A subscription Dodo no longer considers updatable: fall through to a new mandate.
      if (!(error instanceof DodoApiError) || error.status >= 500) throw error;
      deps.log?.(`[billing/dodo] update-payment-method refused for ${accountId}, starting a new checkout: ${error.message}`);
    }
  }

  const email = await ownerEmailOf(deps.db, method.owner_user_id);
  const customer = method.dodo_customer_id
    ? { customerId: method.dodo_customer_id }
    : { email: email ?? "", name: method.name && !method.name.includes("@") ? method.name : null };
  if (!("customerId" in customer) && !customer.email) throw new Error(`Account ${accountId} has no owner email for the Dodo customer`);

  const session = await deps.dodo.createCheckoutSession({
    productId: deps.productId,
    customer,
    returnUrl: `${base}?card=saved`,
    metadata: { unquit_account_id: accountId, unquit_purpose: "billing_method" },
  });
  await attempt("Saving checkout session", () => deps.db.query("update accounts set dodo_checkout_session_id = $2 where id = $1", [accountId, session.sessionId]));
  return { url: session.checkoutUrl, kind: "checkout" };
}

/** Card brand and last 4 for display, from the customer's saved payment methods (best effort). */
async function cardDetails(deps: DodoBillingDeps, customerId: string | null, paymentMethodId: string | null): Promise<{ brand: string | null; last4: string | null } | null> {
  if (!customerId) return null;
  try {
    const methods = await deps.dodo.listCustomerPaymentMethods(customerId);
    const pm = (paymentMethodId && methods.find((m) => m.payment_method_id === paymentMethodId)) || methods[0];
    return pm ? { brand: pm.brand, last4: pm.last4 } : null;
  } catch (error) {
    deps.log?.(`[billing/dodo] reading card details failed (ignored): ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

export type AdoptOutcome = "adopted" | "updated" | "stale" | "foreign" | "not_found";

/**
 * Stores a Dodo subscription on the account it belongs to. Trusts nothing
 * from the browser: the subscription must carry this account's id in its
 * metadata and be for the usage-fees product. Out-of-order events are
 * ignored by comparing the event time with the last status written.
 */
export async function applySubscription(deps: DodoBillingDeps, sub: DodoSubscription, opts: { expectAccountId?: string; at?: Date } = {}): Promise<{ outcome: AdoptOutcome; accountId: string | null }> {
  if (!sub.subscription_id) return { outcome: "not_found", accountId: null };
  if (sub.product_id && sub.product_id !== deps.productId) return { outcome: "foreign", accountId: null };

  const byId = await attempt("Loading account", () =>
    queryOne<{ id: string }>(deps.db, "select id from accounts where dodo_subscription_id = $1", [sub.subscription_id]),
  );
  const metaAccount = sub.metadata.unquit_account_id ?? null;
  const accountId = byId?.id ?? metaAccount;
  if (!accountId || (opts.expectAccountId && accountId !== opts.expectAccountId)) return { outcome: "foreign", accountId: null };
  // A subscription found by metadata must be for our product (the id lookup already proved it).
  if (!byId && sub.product_id !== deps.productId) return { outcome: "foreign", accountId: null };

  const method = await loadMethod(deps.db, accountId);
  if (!method) return { outcome: "not_found", accountId: null };
  const at = opts.at ?? nowOf(deps);

  // Older news about the subscription we already track: ignore.
  if (method.dodo_subscription_id === sub.subscription_id && method.dodo_status_at && new Date(method.dodo_status_at) > at) {
    return { outcome: "stale", accountId };
  }
  // News about a subscription this account has since replaced: only a newer, chargeable one may take over.
  if (method.dodo_subscription_id && method.dodo_subscription_id !== sub.subscription_id && !isChargeable(sub.status)) {
    return { outcome: "stale", accountId };
  }

  const chargeable = isChargeable(sub.status);
  const card = chargeable ? await cardDetails(deps, sub.customer_id ?? method.dodo_customer_id, sub.payment_method_id) : null;
  const replaced = method.dodo_subscription_id !== sub.subscription_id;
  await attempt("Saving billing method", () =>
    deps.db.query(
      `update accounts
          set dodo_subscription_id = $2,
              dodo_subscription_status = $3,
              dodo_customer_id = coalesce($4, dodo_customer_id),
              dodo_payment_method_id = coalesce($5, dodo_payment_method_id),
              dodo_status_at = $6,
              dodo_mandate_at = case when $7::boolean then coalesce(case when $8::boolean then null else dodo_mandate_at end, $6::timestamptz) else dodo_mandate_at end,
              billing_pm_status = case when $7::boolean then 'active' else 'none' end,
              billing_pm_brand = case when $7::boolean then coalesce($9, case when $8::boolean then null else billing_pm_brand end) else billing_pm_brand end,
              billing_pm_last4 = case when $7::boolean then coalesce($10, case when $8::boolean then null else billing_pm_last4 end) else billing_pm_last4 end,
              billing_pm_updated_at = case when $7::boolean then $6::timestamptz else billing_pm_updated_at end
        where id = $1`,
      [
        accountId,
        sub.subscription_id,
        sub.status,
        sub.customer_id,
        sub.payment_method_id,
        at.toISOString(),
        chargeable,
        replaced,
        card?.brand ?? null,
        card?.last4 && /^\d{4}$/.test(card.last4) ? card.last4 : null,
      ],
    ),
  );
  if (chargeable) await wakeChargesAfterCardChange(deps, accountId, at);
  return { outcome: replaced ? "adopted" : "updated", accountId };
}

/**
 * The founder's return from Dodo (…/dashboard/billing?subscription_id=…).
 * Re-reads the subscription from Dodo rather than trusting the query string.
 */
export async function confirmReturn(deps: DodoBillingDeps, accountId: string, subscriptionId: string): Promise<boolean> {
  if (!/^[A-Za-z0-9_-]{4,100}$/.test(subscriptionId)) return false;
  const sub = await deps.dodo.getSubscription(subscriptionId);
  if (!sub) return false;
  const { outcome } = await applySubscription(deps, sub, { expectAccountId: accountId });
  return (outcome === "adopted" || outcome === "updated") && isChargeable(sub.status);
}

/**
 * After a new or updated card: statements waiting for a card are charged at
 * the next run, and an unpaid (or retrying) statement starts one fresh cycle
 * of attempts, beginning now.
 */
async function wakeChargesAfterCardChange(deps: DodoBillingDeps, accountId: string, at: Date): Promise<void> {
  const rows = await attempt("Rescheduling charges", () =>
    deps.db.query<{ id: string }>(
      `update billing_charges
          set status = 'scheduled', next_attempt_at = $2, cycle_started_at = null, cycle_attempts = 0, hard_declined = false
        where account_id = $1
          and (status = 'awaiting_card' or (status in ('unpaid', 'retrying') and attempts_count < $3))
        returning id`,
      [accountId, at.toISOString(), MAX_TOTAL_ATTEMPTS],
    ),
  );
  for (const r of rows) await syncPeriod(deps.db, r.id);
}

// -----------------------------------------------------------------------------
// 2. Statements -> charges (the collector used by lib/billing/service.ts)
// -----------------------------------------------------------------------------

/**
 * Rolls earlier carried-forward (below-minimum) statements into this one.
 * Idempotent: a statement is claimed once, and a re-run reads back what this
 * period already claimed.
 */
export async function claimCarryIn(db: Db, accountId: string, periodId: string): Promise<number> {
  await attempt("Claiming carried-forward amounts", () =>
    db.query(
      `update billing_periods
          set carried_to_period_id = $2
        where account_id = $1 and id <> $2 and payment_status = 'carried_forward' and carried_to_period_id is null
          and period_month < (select period_month from billing_periods where id = $2)`,
      [accountId, periodId],
    ),
  );
  const row = await attempt("Loading carried-forward amounts", () =>
    queryOne<{ total: number | string | null }>(db, "select coalesce(sum(amount_due_cents), 0) as total from billing_periods where carried_to_period_id = $1", [periodId]),
  );
  return Number(row?.total ?? 0);
}

/** One charge per statement. Before any attempt was made the amount may still be corrected. */
export async function scheduleCharge(db: Db, input: { accountId: string; periodId: string; amountCents: number; at: string }): Promise<void> {
  await attempt("Scheduling charge", () =>
    db.query(
      `insert into billing_charges (account_id, billing_period_id, amount_cents, status, next_attempt_at)
       values ($1, $2, $3, 'scheduled', $4)
       on conflict (billing_period_id) do update
         set amount_cents = excluded.amount_cents
         where billing_charges.attempts_count = 0 and billing_charges.status in ('scheduled', 'awaiting_card')`,
      [input.accountId, input.periodId, input.amountCents, input.at],
    ),
  );
}

/** Creates charges for closed statements that somehow have none (a crash between the two writes). */
export async function scheduleMissingCharges(db: Db, at: Date): Promise<number> {
  const rows = await attempt("Scheduling missing charges", () =>
    db.query<{ id: string }>(
      `insert into billing_charges (account_id, billing_period_id, amount_cents, status, next_attempt_at)
       select p.account_id, p.id, p.amount_due_cents, 'scheduled', $1
         from billing_periods p
        where p.status = 'closed' and p.payment_status = 'scheduled' and p.amount_due_cents > 0
          and not exists (select 1 from billing_charges c where c.billing_period_id = p.id)
       on conflict (billing_period_id) do nothing
       returning id`,
      [at.toISOString()],
    ),
  );
  return rows.length;
}

// -----------------------------------------------------------------------------
// 3. Charging
// -----------------------------------------------------------------------------

export type AttemptOutcome =
  | { outcome: "sent"; paymentId: string; attemptNo: number }
  | { outcome: "awaiting_card" }
  | { outcome: "skipped"; reason: string }
  | { outcome: "failed"; code: string; next: "retry" | "unpaid" }
  | { outcome: "unknown"; error: string };

/**
 * Makes ONE attempt on a due charge. The attempt is claimed (status ->
 * processing, attempts + 1, compare-and-set on the old status and count)
 * before Dodo is called, so only one caller ever sends it.
 */
export async function attemptCharge(deps: DodoBillingDeps, chargeId: string, opts: { force?: boolean } = {}): Promise<AttemptOutcome> {
  const now = nowOf(deps);
  const charge = await loadCharge(deps.db, chargeId);
  if (!charge) return { outcome: "skipped", reason: "not_found" };
  if (charge.status !== "scheduled" && charge.status !== "retrying") return { outcome: "skipped", reason: `status_${charge.status}` };
  const dueBy = new Date(now.getTime() + DUE_SLACK_MS);
  if (!opts.force && (!charge.next_attempt_at || new Date(charge.next_attempt_at) > dueBy)) return { outcome: "skipped", reason: "not_due" };
  if (charge.attempts_count >= MAX_TOTAL_ATTEMPTS) return { outcome: "skipped", reason: "attempt_ceiling" };

  const method = await loadMethod(deps.db, charge.account_id);
  if (!method?.dodo_subscription_id || !isChargeable(method.dodo_subscription_status)) {
    const rows = await deps.db.query<{ id: string; failure_emailed_at: string | null }>(
      `update billing_charges set status = 'awaiting_card', next_attempt_at = null
        where id = $1 and status in ('scheduled', 'retrying') returning id, failure_emailed_at`,
      [chargeId],
    );
    await syncPeriod(deps.db, chargeId);
    if (rows[0] && !rows[0].failure_emailed_at) {
      const month = await periodMonth(deps.db, charge.billing_period_id);
      const sent = await notify(
        deps,
        charge.account_id,
        addCardEmail({ amountCents: Number(charge.amount_cents), periodLabel: month ? monthLabel(month) : "last month", billingUrl: billingUrl(deps.appUrl) }),
        `unquit-charge/${chargeId}/add-card`,
      );
      if (sent) await deps.db.query("update billing_charges set failure_emailed_at = $2 where id = $1", [chargeId, now.toISOString()]);
    }
    return { outcome: "awaiting_card" };
  }

  // Claim the attempt.
  const claimed = await attempt("Claiming charge attempt", () =>
    deps.db.query<ChargeRow>(
      `update billing_charges
          set status = 'processing',
              attempts_count = attempts_count + 1,
              cycle_attempts = cycle_attempts + 1,
              cycle_started_at = coalesce(cycle_started_at, $4::timestamptz),
              dodo_subscription_id = $5
        where id = $1 and status = $2 and attempts_count = $3
        returning ${CHARGE_COLUMNS}`,
      [chargeId, charge.status, charge.attempts_count, now.toISOString(), method.dodo_subscription_id],
    ),
  );
  const row = claimed[0];
  if (!row) return { outcome: "skipped", reason: "claimed_elsewhere" };
  const attemptNo = row.attempts_count;

  let attemptId: string;
  try {
    const inserted = await deps.db.query<{ id: string }>(
      `insert into billing_charge_attempts (charge_id, attempt_no, amount_cents, state, sent_at) values ($1, $2, $3, 'sending', $4) returning id`,
      [chargeId, attemptNo, row.amount_cents, now.toISOString()],
    );
    attemptId = inserted[0]!.id;
  } catch (error) {
    // Another attempt is in flight (unique index): leave everything as it is.
    if (isUniqueViolation(error)) return { outcome: "skipped", reason: "attempt_in_flight" };
    throw error;
  }
  await syncPeriod(deps.db, chargeId);

  const month = (await periodMonth(deps.db, row.billing_period_id)) ?? "";
  try {
    const { paymentId } = await deps.dodo.chargeSubscription(method.dodo_subscription_id, {
      amountCents: Number(row.amount_cents),
      description: `Unquit fees${month ? `, ${monthLabel(month)}` : ""}`,
      metadata: {
        unquit_account_id: row.account_id,
        unquit_charge_id: row.id,
        unquit_attempt_id: attemptId,
        unquit_period: month ? monthSlug(month) : "",
        retry_attempt: String(attemptNo - 1),
      },
    });
    await deps.db.query(
      "update billing_charge_attempts set state = 'processing', dodo_payment_id = $2 where id = $1 and state = 'sending'",
      [attemptId, paymentId],
    );
    await deps.db.query("update billing_charges set dodo_payment_id = $2 where id = $1", [chargeId, paymentId]);
    deps.log?.(`[billing/dodo] charge ${chargeId} attempt ${attemptNo} sent: ${paymentId}`);
    return { outcome: "sent", paymentId, attemptNo };
  } catch (error) {
    if (error instanceof DodoApiError && error.definitelyNotCreated) {
      // 429 = more than four failed payments since the last success: stop retrying this card.
      const code = error.status === 429 ? "TOO_MANY_FAILED_PAYMENTS" : error.code ?? `HTTP_${error.status}`;
      await deps.db.query("update billing_charge_attempts set state = 'not_created' where id = $1 and state = 'sending'", [attemptId]);
      const next = await settleFailure(deps, attemptId, code, error.message, { allowNotCreated: true, forceUnpaid: error.status === 429 });
      return { outcome: "failed", code, next: next === "retry" ? "retry" : "unpaid" };
    }
    // Unknown outcome (timeout, 5xx, 409): the attempt stays "sending" and is reconciled later.
    const message = error instanceof Error ? error.message : String(error);
    await deps.db.query("update billing_charge_attempts set error_message = $2 where id = $1", [attemptId, message.slice(0, 1000)]);
    deps.log?.(`[billing/dodo] charge ${chargeId} attempt ${attemptNo} outcome unknown: ${message}`);
    return { outcome: "unknown", error: message };
  }
}

export type ChargeRunSummary = { due: number } & Partial<Record<AttemptOutcome["outcome"], number>> & { reconciled?: number; missing_scheduled?: number };

/** Charges everything due now (the monthly run and the daily retry run). Safe to run any number of times. */
export async function chargeDue(deps: DodoBillingDeps, opts: { limit?: number } = {}): Promise<ChargeRunSummary> {
  const now = nowOf(deps);
  const missing = await scheduleMissingCharges(deps.db, now);
  const reconciled = await reconcileStale(deps);
  const due = await attempt("Loading due charges", () =>
    deps.db.query<{ id: string }>(
      `select id from billing_charges
        where status in ('scheduled', 'retrying') and next_attempt_at <= $1
        order by next_attempt_at asc
        limit $2`,
      [new Date(now.getTime() + DUE_SLACK_MS).toISOString(), opts.limit ?? 100],
    ),
  );
  const summary: ChargeRunSummary = { due: due.length, reconciled, missing_scheduled: missing };
  for (const { id } of due) {
    let result: AttemptOutcome;
    try {
      result = await attemptCharge(deps, id);
    } catch (error) {
      result = { outcome: "unknown", error: error instanceof Error ? error.message : String(error) };
      deps.log?.(`[billing/dodo] charge ${id} crashed: ${result.error}`);
    }
    summary[result.outcome] = (summary[result.outcome] ?? 0) + 1;
  }
  return summary;
}

// -----------------------------------------------------------------------------
// 4. Settling attempts (webhooks and reconciliation)
// -----------------------------------------------------------------------------

async function findAttempt(db: Db, payment: Pick<DodoPayment, "payment_id" | "metadata">): Promise<AttemptRow | null> {
  if (payment.payment_id) {
    const byPayment = await queryOne<AttemptRow>(db, `select ${ATTEMPT_COLUMNS} from billing_charge_attempts where dodo_payment_id = $1`, [payment.payment_id]);
    if (byPayment) return byPayment;
  }
  const attemptId = payment.metadata.unquit_attempt_id;
  if (attemptId && /^[0-9a-f-]{36}$/i.test(attemptId)) {
    const byMeta = await queryOne<AttemptRow>(db, `select ${ATTEMPT_COLUMNS} from billing_charge_attempts where id = $1`, [attemptId]);
    if (byMeta && byMeta.charge_id === payment.metadata.unquit_charge_id) {
      if (!byMeta.dodo_payment_id && payment.payment_id) {
        await db.query("update billing_charge_attempts set dodo_payment_id = $2 where id = $1 and dodo_payment_id is null", [byMeta.id, payment.payment_id]);
        byMeta.dodo_payment_id = payment.payment_id;
      }
      return byMeta;
    }
  }
  return null;
}

/** A payment succeeded: the statement is paid (even if a late success follows a failure). */
export async function settleSuccess(deps: DodoBillingDeps, attemptRow: AttemptRow, payment: DodoPayment): Promise<"paid" | "duplicate"> {
  const now = nowOf(deps);
  const updated = await deps.db.query<{ id: string }>(
    `update billing_charge_attempts set state = 'succeeded', resolved_at = $2, dodo_payment_id = coalesce(dodo_payment_id, $3)
      where id = $1 and state <> 'succeeded' returning id`,
    [attemptRow.id, now.toISOString(), payment.payment_id || null],
  );
  if (updated.length === 0) return "duplicate";
  await deps.db.query(
    `update billing_charges
        set status = case when refunded_cents > 0 then status else 'paid' end,
            paid_at = coalesce(paid_at, $2), dodo_payment_id = $3,
            receipt_url = coalesce($4, receipt_url), next_attempt_at = null, last_error_code = null, last_error_message = null
      where id = $1`,
    [attemptRow.charge_id, now.toISOString(), payment.payment_id || attemptRow.dodo_payment_id, payment.invoice_url],
  );
  await syncPeriod(deps.db, attemptRow.charge_id);
  deps.log?.(`[billing/dodo] charge ${attemptRow.charge_id} paid (${payment.payment_id})`);
  return "paid";
}

/**
 * An attempt failed: schedule the next attempt of the cycle, or mark the
 * statement unpaid (hard decline / last attempt) and email the founder.
 * Idempotent: an attempt is only settled once, and a charge that already
 * moved on (paid, or a newer attempt) is left alone.
 */
export async function settleFailure(
  deps: DodoBillingDeps,
  attemptId: string,
  code: string | null,
  message: string | null,
  opts: { allowNotCreated?: boolean; forceUnpaid?: boolean } = {},
): Promise<"retry" | "unpaid" | "duplicate" | "superseded"> {
  const now = nowOf(deps);
  const states = opts.allowNotCreated ? ["sending", "processing", "not_created"] : ["sending", "processing"];
  const done = await deps.db.query<AttemptRow>(
    `update billing_charge_attempts set state = case when state = 'not_created' then 'not_created' else 'failed' end,
            error_code = $2, error_message = $3, resolved_at = $4
      where id = $1 and state = any($5::text[]) and resolved_at is null
      returning ${ATTEMPT_COLUMNS}`,
    [attemptId, code, message?.slice(0, 1000) ?? null, now.toISOString(), states],
  );
  const att = done[0];
  if (!att) return "duplicate";
  const charge = await loadCharge(deps.db, att.charge_id);
  if (!charge) return "duplicate";
  // Only the latest attempt of a charge that is still waiting on it decides what happens next.
  if (charge.status !== "processing" || att.attempt_no !== charge.attempts_count) return "superseded";

  const cycleStart = charge.cycle_started_at ? new Date(charge.cycle_started_at) : now;
  let decision = afterFailure(cycleStart, charge.cycle_attempts, code);
  if (opts.forceUnpaid || charge.attempts_count >= MAX_TOTAL_ATTEMPTS) decision = { kind: "unpaid", reason: "retries_exhausted" };
  // Never schedule a "retry" into the past (a clock skew or a very late webhook): keep at least a day's gap.
  if (decision.kind === "retry" && decision.at.getTime() < now.getTime() + 86_400_000 - DUE_SLACK_MS) {
    decision = { ...decision, at: new Date(now.getTime() + 86_400_000) };
  }

  const month = await periodMonth(deps.db, charge.billing_period_id);
  const periodLabel = month ? monthLabel(month) : "last month";
  const reason = founderDeclineMessage(code);

  if (decision.kind === "retry") {
    await deps.db.query(
      `update billing_charges set status = 'retrying', next_attempt_at = $2, last_error_code = $3, last_error_message = $4
        where id = $1 and status = 'processing'`,
      [charge.id, decision.at.toISOString(), code, message?.slice(0, 1000) ?? null],
    );
    await syncPeriod(deps.db, charge.id);
    if (!charge.failure_emailed_at) {
      const sent = await notify(
        deps,
        charge.account_id,
        paymentFailedEmail({ amountCents: Number(charge.amount_cents), periodLabel, reason, nextAttemptAt: decision.at, billingUrl: billingUrl(deps.appUrl) }),
        `unquit-charge/${charge.id}/failed`,
      );
      if (sent) await deps.db.query("update billing_charges set failure_emailed_at = $2 where id = $1", [charge.id, now.toISOString()]);
    }
    return "retry";
  }

  await deps.db.query(
    `update billing_charges set status = 'unpaid', unpaid_at = $2, next_attempt_at = null, hard_declined = $3,
            last_error_code = $4, last_error_message = $5
      where id = $1 and status = 'processing'`,
    [charge.id, now.toISOString(), isHardDecline(code), code, message?.slice(0, 1000) ?? null],
  );
  await syncPeriod(deps.db, charge.id);
  // TODO(billing): Saurav hasn't decided whether an unpaid statement pauses product features. It doesn't.
  const sent = await notify(
    deps,
    charge.account_id,
    paymentUnpaidEmail({ amountCents: Number(charge.amount_cents), periodLabel, reason, billingUrl: billingUrl(deps.appUrl) }),
    `unquit-charge/${charge.id}/unpaid/${charge.attempts_count}`,
  );
  if (sent) await deps.db.query("update billing_charges set unpaid_emailed_at = $2 where id = $1", [charge.id, now.toISOString()]);
  return "unpaid";
}

/** Applies a Dodo payment (from a webhook or a lookup) to the attempt it belongs to. */
export async function applyPayment(deps: DodoBillingDeps, payment: DodoPayment, kind: "succeeded" | "failed"): Promise<"processed" | "ignored"> {
  if (payment.is_update_payment_method) return "ignored";
  const att = await findAttempt(deps.db, payment);
  if (!att) return "ignored";
  if (kind === "succeeded") {
    await settleSuccess(deps, att, payment);
    return "processed";
  }
  await settleFailure(deps, att.id, payment.error_code ?? "UNKNOWN_ERROR", payment.error_message);
  return "processed";
}

/**
 * Attempts whose outcome never arrived: a lost response ("sending") or a
 * missing webhook ("processing"). Looks the payment up at Dodo. A "sending"
 * attempt with no payment at Dodo after an hour was never created, and the
 * charge moves on as a soft failure (its next attempt follows the schedule).
 */
export async function reconcileStale(deps: DodoBillingDeps): Promise<number> {
  const now = nowOf(deps);
  const stale = await attempt("Loading stale attempts", () =>
    deps.db.query<AttemptRow & { dodo_subscription_id: string | null }>(
      `select a.id, a.charge_id, a.attempt_no, a.state, a.amount_cents, a.dodo_payment_id, a.error_code, a.error_message, a.sent_at, a.resolved_at,
              c.dodo_subscription_id
         from billing_charge_attempts a join billing_charges c on c.id = a.charge_id
        where a.state in ('sending', 'processing') and a.sent_at < $1
        order by a.sent_at asc limit 50`,
      [new Date(now.getTime() - 15 * 60_000).toISOString()],
    ),
  );
  let settled = 0;
  for (const a of stale) {
    try {
      let payment: DodoPayment | null = null;
      if (a.dodo_payment_id) payment = await deps.dodo.getPayment(a.dodo_payment_id);
      else if (a.dodo_subscription_id) {
        const list = await deps.dodo.listSubscriptionPayments(a.dodo_subscription_id, new Date(new Date(a.sent_at).getTime() - 5 * 60_000));
        payment = list.find((p) => p.metadata.unquit_attempt_id === a.id) ?? null;
      }
      if (payment?.status === "succeeded") {
        await settleSuccess(deps, a, payment);
        settled++;
      } else if (payment && (payment.status === "failed" || payment.status === "cancelled")) {
        if (!a.dodo_payment_id) await deps.db.query("update billing_charge_attempts set dodo_payment_id = $2 where id = $1", [a.id, payment.payment_id]);
        await settleFailure(deps, a.id, payment.error_code ?? "UNKNOWN_ERROR", payment.error_message);
        settled++;
      } else if (!payment && a.state === "sending" && new Date(a.sent_at).getTime() < now.getTime() - 60 * 60_000) {
        await deps.db.query("update billing_charge_attempts set state = 'not_created' where id = $1 and state = 'sending'", [a.id]);
        await settleFailure(deps, a.id, "NOT_CREATED", "Dodo has no payment for this attempt", { allowNotCreated: true });
        settled++;
      }
    } catch (error) {
      deps.log?.(`[billing/dodo] reconciling attempt ${a.id} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return settled;
}

/** A refund Dodo made on one of unquit's charges. Recorded once per refund id. */
export async function applyRefund(
  deps: DodoBillingDeps,
  refund: { refund_id: string; payment_id: string; amount: number | null; currency: string | null; status: string | null },
): Promise<"processed" | "ignored"> {
  if (!refund.refund_id || !refund.payment_id) return "ignored";
  const att = await queryOne<{ charge_id: string; account_id: string; amount_cents: number }>(
    deps.db,
    `select a.charge_id, c.account_id, c.amount_cents from billing_charge_attempts a join billing_charges c on c.id = a.charge_id where a.dodo_payment_id = $1`,
    [refund.payment_id],
  );
  if (!att) return "ignored";
  const amount = Math.max(0, Math.trunc(refund.amount ?? 0));
  const inserted = await deps.db.query<{ dodo_refund_id: string }>(
    `insert into billing_refunds (dodo_refund_id, charge_id, account_id, dodo_payment_id, amount_cents, currency, status)
     values ($1, $2, $3, $4, $5, $6, $7) on conflict (dodo_refund_id) do nothing returning dodo_refund_id`,
    [refund.refund_id, att.charge_id, att.account_id, refund.payment_id, amount, refund.currency, refund.status],
  );
  if (inserted.length === 0) return "processed"; // already recorded
  await deps.db.query(
    `update billing_charges
        set refunded_cents = least(amount_cents, refunded_cents + $2),
            status = case when least(amount_cents, refunded_cents + $2) >= amount_cents then 'refunded' else 'partially_refunded' end,
            paid_at = coalesce(paid_at, $3)
      where id = $1`,
    [att.charge_id, amount, nowOf(deps).toISOString()],
  );
  await syncPeriod(deps.db, att.charge_id);
  return "processed";
}

// -----------------------------------------------------------------------------
// 5. Webhooks
// -----------------------------------------------------------------------------

export type DodoEvent = { type: string; timestamp?: string | null; business_id?: string | null; data: Record<string, unknown> };

export const DODO_EVENTS = new Set([
  "payment.succeeded",
  "payment.failed",
  "subscription.active",
  "subscription.on_hold",
  "subscription.cancelled",
  "subscription.failed",
  "subscription.expired",
  "subscription.updated",
  "refund.succeeded",
]);

export async function handleDodoEvent(deps: DodoBillingDeps, event: DodoEvent): Promise<"processed" | "ignored"> {
  if (!DODO_EVENTS.has(event.type)) return "ignored";
  if (event.type === "payment.succeeded" || event.type === "payment.failed") {
    return applyPayment(deps, parsePayment(event.data), event.type === "payment.succeeded" ? "succeeded" : "failed");
  }
  if (event.type.startsWith("subscription.")) {
    const sub = parseSubscription(event.data);
    if (!sub.status) sub.status = event.type.slice("subscription.".length);
    const at = event.timestamp && !Number.isNaN(Date.parse(event.timestamp)) ? new Date(event.timestamp) : nowOf(deps);
    const { outcome } = await applySubscription(deps, sub, { at });
    return outcome === "adopted" || outcome === "updated" ? "processed" : "ignored";
  }
  if (event.type === "refund.succeeded") {
    const d = event.data;
    return applyRefund(deps, {
      refund_id: String(d.refund_id ?? ""),
      payment_id: String(d.payment_id ?? ""),
      amount: typeof d.amount === "number" ? d.amount : null,
      currency: typeof d.currency === "string" ? d.currency : null,
      status: typeof d.status === "string" ? d.status : null,
    });
  }
  return "ignored";
}

export type WebhookClaim = "new" | "duplicate" | "in_progress";

/** Webhook-id log: a delivery already processed is acknowledged without re-running it. */
export async function claimWebhook(db: Db, webhookId: string, type: string, objectId: string | null, now: Date): Promise<WebhookClaim> {
  const inserted = await db.query<{ webhook_id: string }>(
    `insert into dodo_webhook_events (webhook_id, event_type, object_id, status, received_at) values ($1, $2, $3, 'processing', $4)
     on conflict (webhook_id) do nothing returning webhook_id`,
    [webhookId, type, objectId, now.toISOString()],
  );
  if (inserted.length > 0) return "new";
  // Retry a failed delivery, or one whose processing died (stale for 5 minutes).
  const retried = await db.query<{ webhook_id: string }>(
    `update dodo_webhook_events set status = 'processing', received_at = $2, error = null
      where webhook_id = $1 and (status = 'failed' or (status = 'processing' and received_at < $3))
      returning webhook_id`,
    [webhookId, now.toISOString(), new Date(now.getTime() - 5 * 60_000).toISOString()],
  );
  if (retried.length > 0) return "new";
  const row = await queryOne<{ status: string }>(db, "select status from dodo_webhook_events where webhook_id = $1", [webhookId]);
  return row?.status === "processing" ? "in_progress" : "duplicate";
}

export async function finishWebhook(db: Db, webhookId: string, status: "processed" | "ignored" | "failed", now: Date, error?: string): Promise<void> {
  await db.query("update dodo_webhook_events set status = $2, processed_at = $3, error = $4 where webhook_id = $1", [
    webhookId,
    status,
    now.toISOString(),
    error?.slice(0, 2000) ?? null,
  ]);
}

// -----------------------------------------------------------------------------
// 6. Reads for the dashboard and admin
// -----------------------------------------------------------------------------

/** True when one of the founder's statements is unpaid (the banner; a future feature-pause would read this). */
export async function hasUnpaidStatement(db: Db, accountId: string): Promise<boolean> {
  const row = await queryOne<{ ok: boolean }>(db, "select exists (select 1 from billing_charges where account_id = $1 and status = 'unpaid') as ok", [accountId]);
  return !!row?.ok;
}

export type ChargeView = ChargeRow & { period_month: string };

export async function chargesForAccount(db: Db, accountId: string, limit = 36): Promise<ChargeView[]> {
  return attempt("Loading charges", () =>
    db.query<ChargeView>(
      `select ${CHARGE_COLUMNS.split(", ").map((c) => `c.${c}`).join(", ")}, p.period_month
         from billing_charges c join billing_periods p on p.id = c.billing_period_id
        where c.account_id = $1
        order by p.period_month desc limit $2`,
      [accountId, limit],
    ),
  );
}

export type AdminChargeView = ChargeView & { account_name: string | null; owner_email: string | null; attempts: AttemptRow[] };

/** Every founder's charges (admin only: deliberately not scoped to one account). */
export async function adminCharges(db: Db, limit = 100): Promise<AdminChargeView[]> {
  const rows = await attempt("Loading charges", () =>
    db.query<ChargeView & { account_name: string | null; owner_email: string | null }>(
      `select ${CHARGE_COLUMNS.split(", ").map((c) => `c.${c}`).join(", ")}, p.period_month, a.name as account_name, u.email as owner_email
         from billing_charges c
         join billing_periods p on p.id = c.billing_period_id
         join accounts a on a.id = c.account_id
         left join users u on u.id = a.owner_user_id
        order by c.created_at desc limit $1`,
      [limit],
    ),
  );
  if (rows.length === 0) return [];
  const attempts = await attempt("Loading charge attempts", () =>
    db.query<AttemptRow>(`select ${ATTEMPT_COLUMNS} from billing_charge_attempts where charge_id = any($1::uuid[]) order by attempt_no asc`, [rows.map((r) => r.id)]),
  );
  return rows.map((r) => ({ ...r, attempts: attempts.filter((a) => a.charge_id === r.id) }));
}
