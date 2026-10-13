/**
 * The hosted card-update page (/u/<token>), minus the HTML.
 *
 *   1. loadUpdatePage     verify the link, load the case + live invoice
 *   2. startCardUpdate    create a SetupIntent ON THE FOUNDER'S ACCOUNT for
 *                         the customer (Stripe Elements collects the card and
 *                         runs 3-D Secure if the bank asks)
 *   3. payWithNewCard     make that card the default on the customer and the
 *                         subscription, then pay the open invoice right away
 *      retryCurrentCard   or: pay the invoice with the card already on file
 *   4. confirmAfterAction after a 3DS challenge on the payment itself, check
 *                         the invoice and record the result
 *
 * Attribution: the case is marked `pending_attribution` just before
 * `invoices.pay`, so the invoice.paid webhook (or step 3/4 here, whichever
 * comes first) credits Unquit. A failed attempt clears the mark.
 */
import { recordRecovery } from "./service";
import { linkStatusForCase, verifyLinkToken } from "./token";
import type { CaseWithAccount, DunningRepo } from "./types";

export type LiveInvoice = {
  id: string;
  status: string | null; // draft | open | paid | void | uncollectible
  customerId: string | null;
  subscriptionId: string | null;
  amountDueCents: number;
  amountRemainingCents: number;
  amountPaidCents: number;
  currency: string;
  number: string | null;
  hostedInvoiceUrl: string | null;
  paidAtUnix: number | null;
};

export type SetupIntentInfo = {
  id: string;
  status: string;
  customerId: string | null;
  paymentMethodId: string | null;
  caseId: string | null; // metadata.unquit_dunning_case
};

export type PayOutcome =
  | { status: "paid"; invoice: LiveInvoice }
  | { status: "requires_action"; clientSecret: string }
  | { status: "failed"; message: string; declineCode: string | null };

/** The Stripe calls the page makes, all on the connected account. */
export interface CardUpdateStripe {
  getInvoice(stripeAccount: string, invoiceId: string): Promise<LiveInvoice | null>;
  createSetupIntent(
    stripeAccount: string,
    input: { customerId: string; caseId: string; idempotencyKey: string },
  ): Promise<{ id: string; clientSecret: string }>;
  getSetupIntent(stripeAccount: string, setupIntentId: string): Promise<SetupIntentInfo | null>;
  setDefaultPaymentMethod(
    stripeAccount: string,
    input: { customerId: string; subscriptionId: string | null; paymentMethodId: string; idempotencyKey: string },
  ): Promise<void>;
  /** invoices.pay, on-session. Never throws for a card decline: returns `failed`. */
  payInvoice(
    stripeAccount: string,
    invoiceId: string,
    input: { paymentMethodId: string | null; idempotencyKey: string },
  ): Promise<PayOutcome>;
}

export type CardUpdateDeps = {
  repo: DunningRepo;
  stripe: CardUpdateStripe;
  linkSecret: string;
  now?: () => Date;
};

export type LinkState = "ok" | "invalid" | "expired" | "used" | "closed" | "paid";

export type PageView =
  | { state: Exclude<LinkState, "ok" | "paid">; company: string | null }
  | {
      state: "ok" | "paid";
      caseId: string;
      company: string;
      amountCents: number;
      currency: string;
      invoiceNumber: string | null;
      hostedInvoiceUrl: string | null;
      stripeAccount: string;
      category: string;
    };

export type PayResult =
  | { status: "paid"; amountCents: number; currency: string }
  | { status: "requires_action"; clientSecret: string }
  | { status: "failed"; message: string }
  | { status: "link"; state: Exclude<LinkState, "ok"> };

export class CardUpdateError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

type Resolved = { ok: true; c: CaseWithAccount } | { ok: false; state: Exclude<LinkState, "ok">; c: CaseWithAccount | null };

async function resolveLink(deps: CardUpdateDeps, token: string): Promise<Resolved> {
  const now = deps.now?.() ?? new Date();
  const verified = verifyLinkToken(token, deps.linkSecret, now);
  if (!verified.ok) return { ok: false, state: verified.reason === "expired" ? "expired" : "invalid", c: null };
  const c = await deps.repo.getCase(verified.payload.caseId);
  const status = linkStatusForCase(verified.payload, c);
  if (status === "not_found" || !c) return { ok: false, state: "invalid", c: null };
  if (status === "used") return { ok: false, state: "paid", c };
  if (status === "closed") return { ok: false, state: c.status === "recovered" ? "paid" : "closed", c };
  return { ok: true, c };
}

/** Name shown on the page and as the email sender. */
export type CompanyResolver = (c: CaseWithAccount) => Promise<string>;

export async function loadUpdatePage(deps: CardUpdateDeps, token: string, company: CompanyResolver): Promise<PageView> {
  const now = deps.now?.() ?? new Date();
  const link = await resolveLink(deps, token);
  if (!link.ok) {
    if (link.state === "paid") {
      if (link.c) return view(link.c, "paid", await company(link.c), null);
      return { state: "closed", company: null };
    }
    return { state: link.state, company: link.c ? await company(link.c) : null };
  }
  const c = link.c;
  await deps.repo.markLinkOpened(c.id, now.toISOString());

  const live = await deps.stripe.getInvoice(c.account.stripe_account_id, c.stripe_invoice_id).catch(() => null);
  if (live?.status === "paid") return view(c, "paid", await company(c), live);
  if (live && live.status !== "open") return { state: "closed", company: await company(c) };
  return view(c, "ok", await company(c), live);
}

function view(c: CaseWithAccount, state: "ok" | "paid", company: string, live: LiveInvoice | null): PageView {
  return {
    state,
    caseId: c.id,
    company,
    amountCents: live ? (state === "paid" ? live.amountPaidCents : live.amountRemainingCents) : Number(c.amount_due_cents),
    currency: live?.currency ?? c.currency,
    invoiceNumber: live?.number ?? c.invoice_number,
    hostedInvoiceUrl: live?.hostedInvoiceUrl ?? c.hosted_invoice_url,
    stripeAccount: c.account.stripe_account_id,
    category: c.decline_category ?? "hard",
  };
}

async function requireOpen(deps: CardUpdateDeps, token: string): Promise<CaseWithAccount | PayResult> {
  const link = await resolveLink(deps, token);
  if (!link.ok) return { status: "link", state: link.state };
  return link.c;
}

const isResult = (x: CaseWithAccount | PayResult): x is PayResult => "status" in x && !("account" in x);

export async function startCardUpdate(
  deps: CardUpdateDeps,
  token: string,
): Promise<{ status: "ready"; clientSecret: string; stripeAccount: string } | PayResult> {
  const c = await requireOpen(deps, token);
  if (isResult(c)) return c;
  const now = deps.now?.() ?? new Date();
  const si = await deps.stripe.createSetupIntent(c.account.stripe_account_id, {
    customerId: c.stripe_customer_id,
    caseId: c.id,
    // One SetupIntent per case per minute: a double click doesn't create two.
    idempotencyKey: `unquit_setup_${c.id}_${Math.floor(now.getTime() / 60_000)}`,
  });
  return { status: "ready", clientSecret: si.clientSecret, stripeAccount: c.account.stripe_account_id };
}

async function pay(
  deps: CardUpdateDeps,
  c: CaseWithAccount,
  via: "update_link" | "unquit_retry",
  paymentMethodId: string | null,
  idempotencyKey: string,
): Promise<PayResult> {
  const now = deps.now?.() ?? new Date();
  const markedAt = now.toISOString();
  await deps.repo.setPendingAttribution(c.id, via, markedAt);

  let outcome: PayOutcome;
  try {
    outcome = await deps.stripe.payInvoice(c.account.stripe_account_id, c.stripe_invoice_id, { paymentMethodId, idempotencyKey });
  } catch (error) {
    await deps.repo.clearPendingAttribution(c.id, markedAt);
    throw error;
  }

  if (outcome.status === "failed") {
    await deps.repo.clearPendingAttribution(c.id, markedAt);
    return { status: "failed", message: outcome.message };
  }
  if (outcome.status === "requires_action") return { status: "requires_action", clientSecret: outcome.clientSecret };
  return settlePaid(deps, c, outcome.invoice);
}

async function settlePaid(deps: CardUpdateDeps, c: CaseWithAccount, invoice: LiveInvoice): Promise<PayResult> {
  const now = deps.now?.() ?? new Date();
  await recordRecovery(deps.repo, c.account_id, {
    id: invoice.id,
    amountPaidCents: invoice.amountPaidCents,
    paidAt: invoice.paidAtUnix ? new Date(invoice.paidAtUnix * 1000) : now,
    confirmedByUnquit: true,
  });
  return { status: "paid", amountCents: invoice.amountPaidCents, currency: invoice.currency };
}

/** After Elements confirmed the SetupIntent: save the card as default and pay the invoice with it. */
export async function payWithNewCard(deps: CardUpdateDeps, token: string, setupIntentId: unknown): Promise<PayResult> {
  if (typeof setupIntentId !== "string" || !/^seti_[A-Za-z0-9]+$/.test(setupIntentId)) {
    throw new CardUpdateError(400, "bad_request", "Missing card details. Please try again.");
  }
  const c = await requireOpen(deps, token);
  if (isResult(c)) return c;

  const si = await deps.stripe.getSetupIntent(c.account.stripe_account_id, setupIntentId);
  // The SetupIntent must be for THIS case's customer, created by THIS page.
  if (!si || si.customerId !== c.stripe_customer_id || si.caseId !== c.id) {
    throw new CardUpdateError(404, "bad_setup", "We couldn't find that card. Please enter it again.");
  }
  if (si.status !== "succeeded" || !si.paymentMethodId) {
    return { status: "failed", message: "Your card wasn't confirmed. Please try again or use a different card." };
  }

  await deps.stripe.setDefaultPaymentMethod(c.account.stripe_account_id, {
    customerId: c.stripe_customer_id,
    subscriptionId: c.stripe_subscription_id,
    paymentMethodId: si.paymentMethodId,
    idempotencyKey: `unquit_default_${c.id}_${si.id}`,
  });
  return pay(deps, c, "update_link", si.paymentMethodId, `unquit_pay_${c.id}_${si.id}`);
}

/** "Try my card again": pay with the card already on file. */
export async function retryCurrentCard(deps: CardUpdateDeps, token: string): Promise<PayResult> {
  const c = await requireOpen(deps, token);
  if (isResult(c)) return c;
  const now = deps.now?.() ?? new Date();
  return pay(deps, c, "unquit_retry", null, `unquit_retry_${c.id}_${Math.floor(now.getTime() / 60_000)}`);
}

/** After the customer finished a 3DS challenge on the invoice payment. */
export async function confirmAfterAction(deps: CardUpdateDeps, token: string): Promise<PayResult> {
  const link = await resolveLink(deps, token);
  if (!link.ok && link.state !== "paid") return { status: "link", state: link.state };
  const c = link.c!;
  const invoice = await deps.stripe.getInvoice(c.account.stripe_account_id, c.stripe_invoice_id);
  if (invoice?.status === "paid") return settlePaid(deps, c, invoice);
  if (c.pending_attribution_at) await deps.repo.clearPendingAttribution(c.id, c.pending_attribution_at);
  return { status: "failed", message: "Your bank didn't approve the payment. Please try again or use a different card." };
}
