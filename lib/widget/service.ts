/**
 * What the three widget endpoints actually do, with the database and Stripe
 * passed in as small interfaces. The route handlers only parse requests and
 * authenticate; everything that decides money lives here and is unit-tested
 * with in-memory fakes (service.test.ts).
 */
import {
  CANCELLABLE_STATUSES,
  formatDate,
  offerRecord,
  offersAllowed,
  savedMrrCents,
  selectOffer,
  toOfferView,
  type PriceSnapshot,
  type ResolvedOffer,
  type SubscriptionSnapshot,
} from "@/lib/flows/offers";
import type {
  AcceptResult,
  CancelMode,
  CancelResult,
  FlowConfig,
  OfferView,
  SessionConfig,
} from "@/widget/types";

export class WidgetError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export type SessionStatus = "started" | "offer_shown" | "offer_accepted" | "canceled" | "abandoned";

export type SessionRow = {
  id: string;
  account_id: string;
  stripe_customer_id: string;
  stripe_subscription_id: string;
  status: SessionStatus;
  reason: string | null;
  offer_shown: { view?: OfferView } & Record<string, unknown> | null;
  offer_accepted: boolean;
  offer_accepted_at: string | null;
  offers_enabled: boolean;
  cancel_mode: CancelMode | null;
  started_at: string;
};

export type PendingSaveInput = {
  accountId: string;
  cancelSessionId: string;
  customerId: string;
  subscriptionId: string;
  offer: Record<string, unknown>;
  savedMrrCents: number;
  currency: string;
  /** = when the offer was accepted; verification needs an invoice created after it. */
  createdAt: string;
};

export interface WidgetRepo {
  loadFlow(accountId: string): Promise<FlowConfig>;
  /** Most recent accepted offer on this subscription, optionally ignoring one session. */
  lastAcceptedAt(accountId: string, subscriptionId: string, excludeSessionId?: string): Promise<string | null>;
  createSession(input: {
    accountId: string;
    customerId: string;
    subscriptionId: string;
    mrrAtStartCents: number;
    offersEnabled: boolean;
  }): Promise<SessionRow>;
  getSession(accountId: string, sessionId: string): Promise<SessionRow | null>;
  /** Compare-and-set: only flips a session that has not accepted yet. True if this call won. */
  markAccepted(
    sessionId: string,
    fields: { reason: string; reasonLabel: string; reasonDetail: string | null; offerShown: Record<string, unknown>; acceptedAt: string },
  ): Promise<boolean>;
  /** Inserts the pending save; a second insert for the same session is a no-op. */
  insertPendingSave(input: PendingSaveInput): Promise<void>;
  /** Compare-and-set: only flips a session that is neither accepted nor cancelled. True if this call won. */
  markCanceled(
    sessionId: string,
    fields: {
      reason: string;
      reasonLabel: string;
      reasonDetail: string | null;
      offerShown: Record<string, unknown> | null;
      cancelMode: CancelMode;
      completedAt: string;
    },
  ): Promise<boolean>;
}

export type CancellationFeedback =
  | "customer_service"
  | "low_quality"
  | "missing_features"
  | "other"
  | "switched_service"
  | "too_complex"
  | "too_expensive"
  | "unused";

export interface StripeOps {
  getSubscription(subscriptionId: string): Promise<SubscriptionSnapshot | null>;
  getPrice(priceId: string): Promise<PriceSnapshot | null>;
  applyOffer(subscription: SubscriptionSnapshot, offer: ResolvedOffer, idempotencyKey: string, sessionId: string): Promise<void>;
  cancel(
    subscription: SubscriptionSnapshot,
    mode: CancelMode,
    details: { feedback: CancellationFeedback; comment: string },
    idempotencyKey: string,
  ): Promise<void>;
}

export type WidgetDeps = {
  repo: WidgetRepo;
  stripe: StripeOps;
  now?: () => Date;
};

export type WidgetAuthContext = {
  accountId: string;
  customerId: string;
  subscriptionId: string;
};

const MAX_DETAIL = 500;

/** Maps a reason to Stripe's built-in cancellation feedback values. */
export const STRIPE_FEEDBACK: Record<string, CancellationFeedback> = {
  too_expensive: "too_expensive",
  not_using: "unused",
  missing_feature: "missing_features",
  switching: "switched_service",
  technical_issues: "low_quality",
  other: "other",
};

const NOT_FOUND = () => new WidgetError(404, "not_found", "We couldn't find that subscription.");

/** Loads the subscription and checks it belongs to the signed customer on this connected account. */
async function loadSubscription(deps: WidgetDeps, ctx: WidgetAuthContext): Promise<SubscriptionSnapshot> {
  const sub = await deps.stripe.getSubscription(ctx.subscriptionId);
  // Same answer for "doesn't exist" and "belongs to someone else", so ids can't be probed.
  if (!sub || sub.customerId !== ctx.customerId) throw NOT_FOUND();
  return sub;
}

async function loadPrices(deps: WidgetDeps, flow: FlowConfig, reasonIds?: string[]): Promise<Map<string, PriceSnapshot>> {
  const ids = new Set<string>();
  for (const r of flow.reasons) {
    if (reasonIds && !reasonIds.includes(r.id)) continue;
    if (r.offer.type === "downgrade") ids.add(r.offer.priceId);
  }
  const prices = new Map<string, PriceSnapshot>();
  await Promise.all(
    [...ids].map(async (id) => {
      const price = await deps.stripe.getPrice(id).catch(() => null);
      if (price) prices.set(id, price);
    }),
  );
  return prices;
}

function cleanDetail(detail: unknown): string | null {
  if (typeof detail !== "string") return null;
  const trimmed = detail.trim().slice(0, MAX_DETAIL);
  return trimmed.length > 0 ? trimmed : null;
}

async function loadOwnSession(deps: WidgetDeps, ctx: WidgetAuthContext, sessionId: unknown): Promise<SessionRow> {
  if (typeof sessionId !== "string" || !/^[0-9a-f-]{36}$/i.test(sessionId)) {
    throw new WidgetError(400, "bad_session", "This cancel session is invalid. Please close and try again.");
  }
  const session = await deps.repo.getSession(ctx.accountId, sessionId);
  if (
    !session ||
    session.stripe_customer_id !== ctx.customerId ||
    session.stripe_subscription_id !== ctx.subscriptionId
  ) {
    throw new WidgetError(404, "bad_session", "This cancel session has expired. Please close and try again.");
  }
  return session;
}

// -----------------------------------------------------------------------------
// POST /api/widget/session
// -----------------------------------------------------------------------------

export async function startSession(deps: WidgetDeps, ctx: WidgetAuthContext): Promise<SessionConfig> {
  const now = deps.now?.() ?? new Date();
  const sub = await loadSubscription(deps, ctx);
  if (!CANCELLABLE_STATUSES.has(sub.status)) {
    throw new WidgetError(409, "not_cancellable", "This subscription is already cancelled.");
  }

  const flow = await deps.repo.loadFlow(ctx.accountId);
  const lastAccepted = await deps.repo.lastAcceptedAt(ctx.accountId, ctx.subscriptionId);
  const offersEnabled = offersAllowed(lastAccepted, flow.offerCooldownDays, now);
  const prices = offersEnabled ? await loadPrices(deps, flow) : new Map<string, PriceSnapshot>();

  const session = await deps.repo.createSession({
    accountId: ctx.accountId,
    customerId: ctx.customerId,
    subscriptionId: ctx.subscriptionId,
    mrrAtStartCents: sub.mrrCents,
    offersEnabled,
  });

  const anchor = new Date(session.started_at);
  const offers: Record<string, OfferView | null> = {};
  for (const reason of flow.reasons) {
    const offer = selectOffer(flow, reason.id, { subscription: sub, prices, offersEnabled, anchor });
    offers[reason.id] = offer ? toOfferView(offer) : null;
  }

  return {
    sessionId: session.id,
    offersEnabled,
    cancelMode: flow.cancelMode,
    periodEndsOn: sub.currentPeriodEnd ? formatDate(sub.currentPeriodEnd) : null,
    reasons: flow.reasons.map((r) => ({ id: r.id, label: r.label, freeText: r.freeText === true })),
    offers,
  };
}

// -----------------------------------------------------------------------------
// POST /api/widget/accept
// -----------------------------------------------------------------------------

export async function acceptOffer(
  deps: WidgetDeps,
  ctx: WidgetAuthContext,
  input: { sessionId: unknown; reasonId: unknown; reasonDetail?: unknown },
): Promise<AcceptResult> {
  const now = deps.now?.() ?? new Date();
  const session = await loadOwnSession(deps, ctx, input.sessionId);

  // Idempotency: a repeat call (double click, network retry) returns the first result.
  if (session.offer_accepted) return replayAccept(deps, session);
  if (session.status === "canceled") {
    throw new WidgetError(409, "already_canceled", "This subscription was already cancelled in this session.");
  }

  const flow = await deps.repo.loadFlow(ctx.accountId);
  const reason = flow.reasons.find((r) => r.id === input.reasonId);
  if (!reason) throw new WidgetError(400, "bad_reason", "Please pick a reason first.");

  // Abuse guard, enforced on the server (the widget's view is only a hint).
  const lastAccepted = await deps.repo.lastAcceptedAt(ctx.accountId, ctx.subscriptionId, session.id);
  if (!session.offers_enabled || !offersAllowed(lastAccepted, flow.offerCooldownDays, now)) {
    throw new WidgetError(409, "offer_limit", "This offer isn't available on your subscription right now.");
  }

  const sub = await loadSubscription(deps, ctx);
  const prices = await loadPrices(deps, flow, [reason.id]);
  // The offer is re-derived here from the founder's config: nothing the
  // browser sends can change what gets applied.
  const offer = selectOffer(flow, reason.id, {
    subscription: sub,
    prices,
    offersEnabled: true,
    anchor: new Date(session.started_at),
  });
  if (!offer) throw new WidgetError(409, "no_offer", "This offer isn't available on your subscription right now.");

  // Stripe idempotency key per session: a retry can never apply the offer twice.
  await deps.stripe.applyOffer(sub, offer, `unquit_accept_${session.id}`, session.id);

  const view = toOfferView(offer);
  const saved = savedMrrCents(offer, sub);
  // The snapshot carries everything needed to rebuild the pending save on a retry.
  const record = { ...offerRecord(offer), view, saved_mrr_cents: saved, currency: sub.currency };
  const acceptedAt = now.toISOString();
  const won = await deps.repo.markAccepted(session.id, {
    reason: reason.id,
    reasonLabel: reason.label,
    reasonDetail: cleanDetail(input.reasonDetail),
    offerShown: record,
    acceptedAt,
  });
  if (!won) {
    // A concurrent request accepted first. Return what it recorded.
    const latest = await deps.repo.getSession(ctx.accountId, session.id);
    if (latest?.offer_accepted) return replayAccept(deps, latest);
    throw new WidgetError(409, "conflict", "This session changed while we were working. Please close and try again.");
  }

  await deps.repo.insertPendingSave({
    accountId: ctx.accountId,
    cancelSessionId: session.id,
    customerId: ctx.customerId,
    subscriptionId: ctx.subscriptionId,
    offer: offerRecord(offer),
    savedMrrCents: saved,
    currency: sub.currency,
    createdAt: acceptedAt,
  });

  return { outcome: "saved", offer: view };
}

/**
 * Repeat call for an already-accepted session: no Stripe call. Re-inserting
 * the pending save is a no-op when it exists, and repairs the ledger if the
 * first request died between marking the session and writing the save.
 */
async function replayAccept(deps: WidgetDeps, session: SessionRow): Promise<AcceptResult> {
  const record = session.offer_shown;
  const view = record?.view;
  if (!record || !view || !session.offer_accepted_at) {
    throw new WidgetError(409, "conflict", "This offer was already accepted.");
  }
  const { view: _view, saved_mrr_cents, currency, ...offer } = record;
  void _view;
  await deps.repo.insertPendingSave({
    accountId: session.account_id,
    cancelSessionId: session.id,
    customerId: session.stripe_customer_id,
    subscriptionId: session.stripe_subscription_id,
    offer,
    savedMrrCents: Number(saved_mrr_cents ?? 0),
    currency: typeof currency === "string" ? currency : "usd",
    createdAt: session.offer_accepted_at,
  });
  return { outcome: "saved", offer: view, idempotent: true };
}

// -----------------------------------------------------------------------------
// POST /api/widget/cancel
// -----------------------------------------------------------------------------

export async function cancelSubscription(
  deps: WidgetDeps,
  ctx: WidgetAuthContext,
  input: { sessionId: unknown; reasonId: unknown; reasonDetail?: unknown },
): Promise<CancelResult> {
  const now = deps.now?.() ?? new Date();
  const session = await loadOwnSession(deps, ctx, input.sessionId);
  if (session.offer_accepted) {
    throw new WidgetError(409, "already_saved", "You already accepted an offer, so nothing was cancelled.");
  }

  const sub = await loadSubscription(deps, ctx);
  const endsOn = (mode: CancelMode) => (mode === "period_end" && sub.currentPeriodEnd ? formatDate(sub.currentPeriodEnd) : null);

  if (session.status === "canceled") {
    const mode = session.cancel_mode ?? "period_end";
    return { outcome: "canceled", mode, endsOn: endsOn(mode), idempotent: true };
  }

  const flow = await deps.repo.loadFlow(ctx.accountId);
  const reason = flow.reasons.find((r) => r.id === input.reasonId);
  if (!reason) throw new WidgetError(400, "bad_reason", "Please pick a reason first.");
  const detail = cleanDetail(input.reasonDetail);

  // Record which offer the customer turned down (for the dashboard), if any.
  let declined: Record<string, unknown> | null = null;
  if (session.offers_enabled) {
    const prices = await loadPrices(deps, flow, [reason.id]);
    const offer = selectOffer(flow, reason.id, {
      subscription: sub,
      prices,
      offersEnabled: true,
      anchor: new Date(session.started_at),
    });
    declined = offer ? { ...offerRecord(offer), view: toOfferView(offer) } : null;
  }

  const mode = flow.cancelMode;
  if (CANCELLABLE_STATUSES.has(sub.status)) {
    await deps.stripe.cancel(
      sub,
      mode,
      {
        feedback: STRIPE_FEEDBACK[reason.id] ?? "other",
        comment: `${reason.label}${detail ? `: ${detail}` : ""}`.slice(0, 500),
      },
      `unquit_cancel_${session.id}`,
    );
  }

  await deps.repo.markCanceled(session.id, {
    reason: reason.id,
    reasonLabel: reason.label,
    reasonDetail: detail,
    offerShown: declined,
    cancelMode: mode,
    completedAt: now.toISOString(),
  });

  return { outcome: "canceled", mode, endsOn: endsOn(mode) };
}
