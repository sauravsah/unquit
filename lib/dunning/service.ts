/**
 * What dunning actually does, with the database, Stripe and the email client
 * passed in as small interfaces (like lib/widget/service.ts). Route handlers
 * and the webhook only wire these up; everything that decides who gets an
 * email or a fee lives here and is unit-tested with in-memory fakes.
 */
import type { EmailClient } from "@/lib/email";
import { billingMonthOf } from "@/lib/saves/rules";
import { dunningSaveFeeCents, formatCents } from "@/lib/pricing";
import { decideAttribution, type Attribution } from "./attribution";
import { categorizeDecline, primaryDeclineCode, type DeclineCategory } from "./declines";
import { decideSequenceAction, firstEmailAt, nextEmailAfter, type LiveState, type StopReason } from "./schedule";
import type { DunningSettings } from "./settings";
import { fillText, renderEmail, type TemplateVars } from "./templates";
import { issueLinkToken } from "./token";
import type { CaseWithAccount, DunningCaseRow, DunningRepo, FailedInvoice, PaidInvoiceInfo } from "./types";

/** Stripe reads the cron needs: is the invoice still unpaid, is the subscription alive? */
export interface DunningStripe {
  getLiveState(stripeAccount: string, invoiceId: string, subscriptionId: string | null): Promise<LiveState>;
}

export type SequenceConfig = {
  appUrl: string;
  linkSecret: string;
  /** e.g. billing@mail.unquit.app (domain verified in Resend). */
  fromAddress: string;
};

export type SequenceDeps = {
  repo: DunningRepo;
  stripe: DunningStripe;
  email: EmailClient;
  config: SequenceConfig;
  now?: () => Date;
  log?: (line: string) => void;
};

// -----------------------------------------------------------------------------
// invoice.payment_failed
// -----------------------------------------------------------------------------

/**
 * Opens a case for a failed invoice (first failure) or refreshes it (later
 * failures): amount, attempts, decline code and category. A recovered or
 * closed case is never reopened. The email sequence is scheduled from the
 * first failure and is not restarted by later ones.
 */
export async function openOrUpdateCase(
  repo: DunningRepo,
  accountId: string,
  invoice: FailedInvoice,
  now: Date,
): Promise<{ caseId: string | null; created: boolean; category: DeclineCategory }> {
  const category = categorizeDecline({ declineCode: invoice.declineCode, errorCode: invoice.errorCode });
  const decline = {
    decline_code: primaryDeclineCode({ declineCode: invoice.declineCode, errorCode: invoice.errorCode }),
    decline_category: category,
    last_failure_code: invoice.errorCode ?? invoice.declineCode,
    last_failure_message: invoice.failureMessage,
    stripe_payment_intent_id: invoice.paymentIntentId,
  };
  const fields = {
    stripe_customer_id: invoice.customerId,
    stripe_subscription_id: invoice.subscriptionId,
    amount_due_cents: invoice.amountDueCents,
    currency: invoice.currency,
    attempt_count: invoice.attemptCount,
    next_payment_attempt_at: invoice.nextPaymentAttemptAt,
    hosted_invoice_url: invoice.hostedInvoiceUrl,
    customer_email: invoice.customerEmail,
    customer_name: invoice.customerName,
    invoice_number: invoice.number,
  };

  const existing = await repo.findCaseByInvoice(accountId, invoice.id);
  if (existing) {
    if (existing.status === "open") await repo.updateOpenCase(existing.id, { ...fields, ...decline });
    return { caseId: existing.id, created: false, category };
  }

  const settings = await repo.getSettings(accountId);
  const inserted = await repo.insertCase({
    account_id: accountId,
    stripe_invoice_id: invoice.id,
    ...fields,
    ...decline,
    opened_at: now.toISOString(),
    next_email_at: firstEmailAt(now, settings.scheduleDays).toISOString(),
  });
  if (!inserted) {
    // A concurrent delivery opened it a moment ago: treat as an update.
    const again = await repo.findCaseByInvoice(accountId, invoice.id);
    if (again?.status === "open") await repo.updateOpenCase(again.id, { ...fields, ...decline });
    return { caseId: again?.id ?? null, created: false, category };
  }
  return { caseId: inserted.id, created: true, category };
}

// -----------------------------------------------------------------------------
// customer.subscription.deleted / updated to canceled
// -----------------------------------------------------------------------------

export async function stopForCanceledSubscription(repo: DunningRepo, accountId: string, subscriptionId: string, now: Date) {
  return repo.closeCasesForSubscription(accountId, subscriptionId, now.toISOString());
}

// -----------------------------------------------------------------------------
// invoice.paid (and the card-update page's own success path)
// -----------------------------------------------------------------------------

export type RecoveryResult =
  | { recorded: false; reason: "no_case" | "not_open" }
  | { recorded: true; attribution: Attribution; won: boolean; saveRecorded: boolean };

/**
 * Closes the case for a paid invoice and, when Unquit earned it, records the
 * dunning save (10% fee). Safe to call more than once and from both the
 * webhook and the card-update page: the open -> recovered flip is a
 * compare-and-set, the save is unique per case, and a retry repairs a save
 * that a crash left unwritten.
 */
export async function recordRecovery(
  repo: DunningRepo,
  accountId: string,
  invoice: PaidInvoiceInfo,
): Promise<RecoveryResult> {
  let c = await repo.findCaseByInvoice(accountId, invoice.id);
  if (!c) return { recorded: false, reason: "no_case" };

  let won = false;
  let attribution: Attribution | null = null;
  if (c.status === "open") {
    attribution = decideAttribution(
      {
        pendingAttribution: c.pending_attribution,
        pendingAttributionAt: c.pending_attribution_at,
        linkFirstOpenedAt: c.link_first_opened_at,
      },
      invoice.paidAt,
      invoice.amountPaidCents,
    );
    won = await repo.markRecovered(c.id, {
      via: attribution.via,
      amountCents: invoice.amountPaidCents,
      at: invoice.paidAt.toISOString(),
    });
    if (!won) {
      c = (await repo.findCaseByInvoice(accountId, invoice.id)) ?? c;
    }
  }

  if (!won || !attribution) {
    if (c.status !== "recovered") return { recorded: false, reason: "not_open" };
    // Already recovered (a duplicate delivery, or the page beat the webhook).
    const via = c.recovered_via ?? "external";
    const amount = Number(c.recovered_amount_cents ?? invoice.amountPaidCents);
    attribution =
      via === "external"
        ? { via, billable: false, feeCents: 0, reason: "already recorded as external" }
        : {
            via,
            billable: true,
            feeCents: dunningSaveFeeCents(amount),
            reason: "already recorded",
          };
  }

  let saveRecorded = false;
  if (attribution.billable && attribution.via !== "external") {
    const amount = Number(c.recovered_amount_cents ?? invoice.amountPaidCents) || invoice.amountPaidCents;
    const verifiedAt = c.recovered_at ?? invoice.paidAt.toISOString();
    await repo.upsertDunningSave({
      accountId,
      caseId: c.id,
      customerId: c.stripe_customer_id,
      subscriptionId: c.stripe_subscription_id,
      invoiceId: invoice.id,
      recoveredAmountCents: amount,
      currency: c.currency,
      feeCents: dunningSaveFeeCents(amount),
      attributedVia: attribution.via,
      verifiedAt,
      billingMonth: billingMonthOf(Math.floor(Date.parse(verifiedAt) / 1000)),
    });
    saveRecorded = true;
  }

  return { recorded: true, attribution, won, saveRecorded };
}

// -----------------------------------------------------------------------------
// The email sequence (cron)
// -----------------------------------------------------------------------------

export type CaseOutcome =
  | "sent"
  | "logged"
  | "stopped"
  | "waiting"
  | "skipped"
  | "already_sent"
  | "in_flight"
  | "gave_up"
  | "failed";

export type RunSummary = { considered: number } & Partial<Record<CaseOutcome, number>>;

/** "Acme" <billing@…> with anything that could break the header removed. */
export function formatFrom(company: string, address: string): string {
  const name = company.replace(/[\r\n"<>\\]/g, "").trim().slice(0, 100) || "Billing";
  return `"${name}" <${address}>`;
}

export function companyNameFor(settings: DunningSettings, account: { name: string | null }): string {
  const fromSettings = settings.companyName?.trim();
  if (fromSettings) return fromSettings;
  // Week 1 defaults accounts.name to the founder's email; never show that to customers.
  const fromAccount = account.name?.trim();
  if (fromAccount && !fromAccount.includes("@")) return fromAccount;
  return "Your subscription";
}

export function clickUrl(appUrl: string, emailId: string, token: string): string {
  return `${appUrl}/api/dunning/click/${emailId}?t=${encodeURIComponent(token)}`;
}

export function openPixelUrl(appUrl: string, emailId: string): string {
  return `${appUrl}/api/dunning/open/${emailId}`;
}

export function updatePageUrl(appUrl: string, token: string): string {
  return `${appUrl}/u/${token}`;
}

/** Processes one case. Exported for tests and for the webhook's immediate day-0 send. */
export async function processCase(
  deps: SequenceDeps,
  c: CaseWithAccount,
  settings: DunningSettings,
): Promise<CaseOutcome> {
  const now = deps.now?.() ?? new Date();
  const log = deps.log ?? (() => {});
  if (!settings.enabled) return "skipped";

  let live: LiveState;
  try {
    live = await deps.stripe.getLiveState(c.account.stripe_account_id, c.stripe_invoice_id, c.stripe_subscription_id);
  } catch (error) {
    log(`[dunning] case ${c.id}: Stripe lookup failed, will retry next run: ${messageOf(error)}`);
    return "failed";
  }

  const action = decideSequenceAction(c, live, now);
  if (action.action === "skip") return "skipped";
  if (action.action === "wait") return "waiting";
  if (action.action === "stop") {
    await deps.repo.stopSequence(c.id, action.reason, now.toISOString());
    return "stopped";
  }

  const step = action.step;
  const category: DeclineCategory = c.decline_category ?? "hard";
  const template = settings.templates[category][step]!;
  const company = companyNameFor(settings, c.account);
  const baseVars: TemplateVars = {
    customer_name: c.customer_name?.trim().split(/\s+/)[0] || "there",
    amount: formatCents(Number(c.amount_due_cents), c.currency),
    update_link: "",
    company,
  };
  const subject = fillText(template.subject, baseVars).replace(/[\r\n]+/g, " ").trim();

  const claim = await deps.repo.claimEmail({
    accountId: c.account_id,
    caseId: c.id,
    step,
    category,
    toEmail: c.customer_email!,
    subject,
  });
  if (claim.outcome === "in_flight") return "in_flight";
  if (claim.outcome === "already_sent" || claim.outcome === "gave_up") {
    // The email went out (or never will); a previous run died before moving on.
    await advance(deps, c, settings, step, now);
    return claim.outcome;
  }

  const token = issueLinkToken(c.id, c.link_nonce, deps.config.linkSecret, now);
  const rendered = renderEmail(
    template,
    { ...baseVars, update_link: clickUrl(deps.config.appUrl, claim.emailId, token) },
    { category, openPixelUrl: openPixelUrl(deps.config.appUrl, claim.emailId) },
  );

  let result;
  try {
    result = await deps.email.send({
      from: formatFrom(company, deps.config.fromAddress || "billing@example.invalid"),
      to: c.customer_email!,
      replyTo: settings.replyToEmail ?? undefined,
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text,
      idempotencyKey: `dunning/${c.id}/${step}`,
      tags: { kind: "dunning", step: String(step + 1), category },
    });
  } catch (error) {
    await deps.repo.markEmailFailed(claim.emailId, messageOf(error).slice(0, 1000));
    log(`[dunning] case ${c.id}: email ${step + 1} failed, will retry: ${messageOf(error)}`);
    return "failed";
  }

  await deps.repo.markEmailSent(claim.emailId, {
    status: result.delivered ? "sent" : "logged",
    providerMessageId: result.id,
    sentAt: now.toISOString(),
  });
  await advance(deps, c, settings, step, now);
  return result.delivered ? "sent" : "logged";
}

async function advance(deps: SequenceDeps, c: DunningCaseRow, settings: DunningSettings, step: number, now: Date) {
  const next = nextEmailAfter(step, new Date(c.opened_at), settings.scheduleDays, now);
  const moved = await deps.repo.advanceSequence(c.id, step, next ? next.toISOString() : null, now.toISOString());
  if (moved && !next) await deps.repo.stopSequence(c.id, "completed" satisfies StopReason, now.toISOString());
}

/**
 * The cron run: every due case on every account with dunning switched on.
 * Safe to run twice at once or back to back: each email is claimed in the
 * database before it is sent, and Resend gets an idempotency key.
 */
export async function runDunningSequence(deps: SequenceDeps, options: { limit?: number } = {}): Promise<RunSummary> {
  const now = deps.now?.() ?? new Date();
  const cases = await deps.repo.dueCases(now, options.limit ?? 200);
  const summary: RunSummary = { considered: cases.length };
  const settingsByAccount = new Map<string, DunningSettings>();

  for (const c of cases) {
    let settings = settingsByAccount.get(c.account_id);
    if (!settings) {
      settings = await deps.repo.getSettings(c.account_id);
      settingsByAccount.set(c.account_id, settings);
    }
    let outcome: CaseOutcome;
    try {
      outcome = await processCase(deps, c, settings);
    } catch (error) {
      (deps.log ?? (() => {}))(`[dunning] case ${c.id} crashed: ${messageOf(error)}`);
      outcome = "failed";
    }
    summary[outcome] = (summary[outcome] ?? 0) + 1;
  }
  return summary;
}

/** Sends a newly opened case's day-0 email straight away instead of waiting for the next cron run. */
export async function runDunningForCase(deps: SequenceDeps, caseId: string): Promise<CaseOutcome> {
  const c = await deps.repo.getCase(caseId);
  if (!c) return "skipped";
  const settings = await deps.repo.getSettings(c.account_id);
  return processCase(deps, c, settings);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
