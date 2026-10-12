import { describe, expect, it } from "vitest";
import type { ResolvedOffer, SubscriptionSnapshot } from "@/lib/flows/offers";
import { templateFlow } from "@/lib/flows/templates";
import type { CancelMode, FlowConfig } from "@/widget/types";
import {
  acceptOffer,
  cancelSubscription,
  startSession,
  WidgetError,
  type PendingSaveInput,
  type SessionRow,
  type StripeOps,
  type WidgetAuthContext,
  type WidgetRepo,
} from "./service";

// -----------------------------------------------------------------------------
// In-memory fakes that behave like the real database and Stripe:
//   * saves are unique per cancel_session_id (saves_cancel_session_id_key)
//   * markAccepted / markCanceled are compare-and-set
//   * Stripe replays a request with a known idempotency key instead of re-running it
// -----------------------------------------------------------------------------

let uuidCounter = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++uuidCounter).padStart(12, "0")}`;

function fakeRepo(flow: FlowConfig = templateFlow("balanced")) {
  const sessions = new Map<string, SessionRow & Record<string, unknown>>();
  const saves: PendingSaveInput[] = [];
  let failNextSaveInsert = false;
  const superseded: { subscriptionId: string; keepSessionId: string }[] = [];
  const ended: { subscriptionId: string; sessionId: string }[] = [];
  const repo: WidgetRepo = {
    async supersedeEarlierSaves(input) {
      superseded.push({ subscriptionId: input.subscriptionId, keepSessionId: input.keepSessionId });
    },
    async endSavesOnCancel(input) {
      ended.push({ subscriptionId: input.subscriptionId, sessionId: input.sessionId });
    },
    async loadFlow() {
      return flow;
    },
    async lastAcceptedAt(accountId, subscriptionId, exclude) {
      const accepted = [...sessions.values()]
        .filter((s) => s.account_id === accountId && s.stripe_subscription_id === subscriptionId && s.offer_accepted && s.id !== exclude)
        .map((s) => s.offer_accepted_at!)
        .sort();
      return accepted.at(-1) ?? null;
    },
    async createSession(input) {
      const row: SessionRow = {
        id: uuid(),
        account_id: input.accountId,
        stripe_customer_id: input.customerId,
        stripe_subscription_id: input.subscriptionId,
        status: "started",
        reason: null,
        offer_shown: null,
        offer_accepted: false,
        offer_accepted_at: null,
        offers_enabled: input.offersEnabled,
        cancel_mode: null,
        started_at: "2026-05-01T10:00:00.000Z",
      };
      sessions.set(row.id, row);
      return { ...row };
    },
    async getSession(accountId, id) {
      const s = sessions.get(id);
      return s && s.account_id === accountId ? { ...s } : null;
    },
    async markAccepted(id, f) {
      const s = sessions.get(id);
      if (!s || s.offer_accepted || s.status === "canceled") return false;
      Object.assign(s, {
        status: "offer_accepted",
        reason: f.reason,
        reason_detail: f.reasonDetail,
        offer_shown: f.offerShown,
        offer_accepted: true,
        offer_accepted_at: f.acceptedAt,
      });
      return true;
    },
    async insertPendingSave(input) {
      if (failNextSaveInsert) {
        failNextSaveInsert = false;
        throw new Error("database blip");
      }
      if (saves.some((s) => s.cancelSessionId === input.cancelSessionId)) return; // unique constraint, DO NOTHING
      saves.push(input);
    },
    async markCanceled(id, f) {
      const s = sessions.get(id);
      if (!s || s.offer_accepted || s.status === "canceled") return false;
      Object.assign(s, {
        status: "canceled",
        reason: f.reason,
        reason_detail: f.reasonDetail,
        offer_shown: f.offerShown,
        cancel_mode: f.cancelMode,
      });
      return true;
    },
  };
  return {
    repo,
    sessions,
    saves,
    superseded,
    ended,
    failNextSaveInsert: () => {
      failNextSaveInsert = true;
    },
  };
}

const SUB: SubscriptionSnapshot = {
  id: "sub_1",
  customerId: "cus_1",
  status: "active",
  currency: "usd",
  livemode: false,
  mrrCents: 4_900,
  items: [{ id: "si_1", priceId: "price_pro", quantity: 1, monthlyCents: 4_900 }],
  hasDiscount: false,
  paused: false,
  cancelAtPeriodEnd: false,
  currentPeriodEnd: Date.UTC(2026, 4, 20) / 1000,
};

function fakeStripe(subscription: SubscriptionSnapshot | null = SUB) {
  const seenKeys = new Map<string, string>();
  const applied: { offer: ResolvedOffer; key: string }[] = [];
  const cancels: { mode: CancelMode; feedback: string; comment: string; key: string }[] = [];
  let calls = 0;
  const idempotent = (key: string, body: unknown, run: () => void) => {
    calls++;
    const fingerprint = JSON.stringify(body);
    const prior = seenKeys.get(key);
    if (prior !== undefined) {
      if (prior !== fingerprint) throw Object.assign(new Error("idempotency mismatch"), { type: "StripeIdempotencyError" });
      return; // Stripe replays the stored response
    }
    seenKeys.set(key, fingerprint);
    run();
  };
  const stripe: StripeOps = {
    async getSubscription(id) {
      return subscription && subscription.id === id ? { ...subscription } : null;
    },
    async getPrice() {
      return null;
    },
    async applyOffer(_sub, offer, key) {
      idempotent(key, offer, () => applied.push({ offer, key }));
    },
    async cancel(_sub, mode, details, key) {
      idempotent(key, { mode, details }, () => cancels.push({ mode, ...details, key }));
    },
  };
  return { stripe, applied, cancels, calls: () => calls };
}

const CTX: WidgetAuthContext = { accountId: "acc_1", customerId: "cus_1", subscriptionId: "sub_1" };
const NOW = () => new Date("2026-05-01T10:05:00.000Z");

function setup(flow?: FlowConfig, subscription?: SubscriptionSnapshot | null) {
  const db = fakeRepo(flow);
  const s = fakeStripe(subscription === undefined ? SUB : subscription);
  return { db, s, deps: { repo: db.repo, stripe: s.stripe, now: NOW } };
}

async function expectWidgetError(promise: Promise<unknown>, status: number, code: string) {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(WidgetError);
  expect(error).toMatchObject({ status, code });
}

describe("POST /session", () => {
  it("returns the reasons and the offer each reason earns, and opens a session", async () => {
    const { db, deps } = setup();
    const config = await startSession(deps, CTX);
    expect(config.offersEnabled).toBe(true);
    expect(config.cancelMode).toBe("period_end");
    expect(config.periodEndsOn).toBe("May 20, 2026");
    expect(config.reasons).toHaveLength(6);
    expect(config.offers.too_expensive).toEqual({ type: "discount", percentOff: 30, months: 3 });
    expect(config.offers.not_using).toEqual({ type: "pause", months: 2, resumesOn: "July 1, 2026" });
    expect(db.sessions.get(config.sessionId)).toMatchObject({ status: "started", offers_enabled: true });
  });

  it("refuses a subscription that belongs to another customer, or doesn't exist on the connected account", async () => {
    const other = setup(undefined, { ...SUB, customerId: "cus_someone_else" });
    await expectWidgetError(startSession(other.deps, CTX), 404, "not_found");
    const missing = setup(undefined, null);
    await expectWidgetError(startSession(missing.deps, CTX), 404, "not_found");
    expect(other.db.sessions.size + missing.db.sessions.size).toBe(0);
  });

  it("refuses an already-cancelled subscription", async () => {
    const { deps } = setup(undefined, { ...SUB, status: "canceled" });
    await expectWidgetError(startSession(deps, CTX), 409, "not_cancellable");
  });
});

describe("POST /accept", () => {
  it("applies the reason's offer once and records a pending save with the saved MRR", async () => {
    const { db, s, deps } = setup();
    const { sessionId } = await startSession(deps, CTX);
    const result = await acceptOffer(deps, CTX, { sessionId, reasonId: "too_expensive", reasonDetail: "  " });

    expect(result).toEqual({ outcome: "saved", offer: { type: "discount", percentOff: 30, months: 3 } });
    expect(s.applied).toEqual([
      { offer: { type: "discount", percentOff: 30, months: 3 }, key: `unquit_accept_${sessionId}` },
    ]);
    expect(db.saves).toHaveLength(1);
    expect(db.saves[0]).toMatchObject({
      cancelSessionId: sessionId,
      customerId: "cus_1",
      subscriptionId: "sub_1",
      savedMrrCents: 3_430, // $49 - 30%
      currency: "usd",
      createdAt: NOW().toISOString(),
      offer: { type: "discount", percent_off: 30, months: 3 },
    });
    expect(db.sessions.get(sessionId)).toMatchObject({ status: "offer_accepted", offer_accepted: true, reason: "too_expensive" });
    // Week 4: older pending saves on the subscription are superseded by this one.
    expect(db.superseded).toEqual([{ subscriptionId: "sub_1", keepSessionId: sessionId }]);
  });

  it("is idempotent: a repeat call returns the same result without touching Stripe again", async () => {
    const { db, s, deps } = setup();
    const { sessionId } = await startSession(deps, CTX);
    const first = await acceptOffer(deps, CTX, { sessionId, reasonId: "not_using" });
    const callsAfterFirst = s.calls();
    const second = await acceptOffer(deps, CTX, { sessionId, reasonId: "not_using" });

    expect(second).toEqual({ ...first, idempotent: true });
    expect(s.calls()).toBe(callsAfterFirst);
    expect(s.applied).toHaveLength(1);
    expect(db.saves).toHaveLength(1);
    expect(db.saves[0]!.savedMrrCents).toBe(4_900); // pause keeps full MRR
  });

  it("is idempotent under concurrent double-clicks: one Stripe change, one save", async () => {
    const { db, s, deps } = setup();
    const { sessionId } = await startSession(deps, CTX);
    const results = await Promise.all([
      acceptOffer(deps, CTX, { sessionId, reasonId: "too_expensive" }),
      acceptOffer(deps, CTX, { sessionId, reasonId: "too_expensive" }),
      acceptOffer(deps, CTX, { sessionId, reasonId: "too_expensive" }),
    ]);
    expect(results.every((r) => r.outcome === "saved")).toBe(true);
    expect(s.applied).toHaveLength(1);
    expect(db.saves).toHaveLength(1);
  });

  it("repairs a missing pending save when the first request died after marking the session", async () => {
    const { db, deps } = setup();
    const { sessionId } = await startSession(deps, CTX);
    db.failNextSaveInsert();
    await expect(acceptOffer(deps, CTX, { sessionId, reasonId: "too_expensive" })).rejects.toThrow("database blip");
    expect(db.saves).toHaveLength(0);

    const retry = await acceptOffer(deps, CTX, { sessionId, reasonId: "too_expensive" });
    expect(retry.idempotent).toBe(true);
    expect(db.saves).toHaveLength(1);
    expect(db.saves[0]).toMatchObject({ savedMrrCents: 3_430, offer: { type: "discount", percent_off: 30, months: 3 } });
  });

  it("enforces the abuse guard on the server: no second offer within the cooldown", async () => {
    const { db, s, deps } = setup();
    const first = await startSession(deps, CTX);
    await acceptOffer(deps, CTX, { sessionId: first.sessionId, reasonId: "too_expensive" });

    // The customer comes back to cancel again a few minutes later.
    const second = await startSession(deps, CTX);
    expect(second.offersEnabled).toBe(false);
    expect(Object.values(second.offers).every((o) => o === null)).toBe(true);

    // Even a hand-crafted accept request is refused.
    await expectWidgetError(acceptOffer(deps, CTX, { sessionId: second.sessionId, reasonId: "too_expensive" }), 409, "offer_limit");
    expect(s.applied).toHaveLength(1);
    expect(db.saves).toHaveLength(1);
  });

  it("lets offers through again after a founder-configured cooldown", async () => {
    const flow = { ...templateFlow("balanced"), offerCooldownDays: 0 };
    const { deps } = setup(flow);
    const first = await startSession(deps, CTX);
    await acceptOffer(deps, CTX, { sessionId: first.sessionId, reasonId: "too_expensive" });
    expect((await startSession(deps, CTX)).offersEnabled).toBe(true);
  });

  it("re-derives the offer on the server and refuses reasons without one", async () => {
    const flow = templateFlow("balanced");
    flow.reasons = flow.reasons.map((r) => (r.id === "other" ? { ...r, offer: { type: "none" } } : r));
    const { s, deps } = setup(flow);
    const { sessionId } = await startSession(deps, CTX);
    await expectWidgetError(acceptOffer(deps, CTX, { sessionId, reasonId: "other" }), 409, "no_offer");
    await expectWidgetError(acceptOffer(deps, CTX, { sessionId, reasonId: "nope" }), 400, "bad_reason");
    expect(s.applied).toHaveLength(0);
  });

  it("won't act on a session that belongs to a different subscription", async () => {
    const { deps } = setup();
    const { sessionId } = await startSession(deps, CTX);
    await expectWidgetError(
      acceptOffer(deps, { ...CTX, subscriptionId: "sub_2" }, { sessionId, reasonId: "too_expensive" }),
      404,
      "bad_session",
    );
    await expectWidgetError(acceptOffer(deps, CTX, { sessionId: "not-a-uuid", reasonId: "too_expensive" }), 400, "bad_session");
  });
});

describe("POST /cancel", () => {
  it("cancels at period end by default and records the reason and the offer that was turned down", async () => {
    const { db, s, deps } = setup();
    const { sessionId } = await startSession(deps, CTX);
    const result = await cancelSubscription(deps, CTX, { sessionId, reasonId: "other", reasonDetail: "Closing the company" });

    expect(result).toEqual({ outcome: "canceled", mode: "period_end", endsOn: "May 20, 2026" });
    expect(s.cancels).toEqual([
      { mode: "period_end", feedback: "other", comment: "Other: Closing the company", key: `unquit_cancel_${sessionId}` },
    ]);
    expect(db.sessions.get(sessionId)).toMatchObject({
      status: "canceled",
      reason: "other",
      reason_detail: "Closing the company",
      offer_shown: { type: "discount", percent_off: 20, months: 2 },
    });
    expect(db.saves).toHaveLength(0);
    // Week 4: cancelling ends earlier saves on the subscription (pending -> lost, verified -> no more months).
    expect(db.ended).toEqual([{ subscriptionId: "sub_1", sessionId }]);
  });

  it("ends earlier saves only once, even when the cancel is repeated", async () => {
    const { db, deps } = setup();
    const { sessionId } = await startSession(deps, CTX);
    await cancelSubscription(deps, CTX, { sessionId, reasonId: "other" });
    await cancelSubscription(deps, CTX, { sessionId, reasonId: "other" });
    expect(db.ended).toHaveLength(1);
  });

  it("cancels immediately when the founder chose that, mapping the reason to Stripe's feedback", async () => {
    const { s, deps } = setup({ ...templateFlow("balanced"), cancelMode: "immediately" });
    const { sessionId } = await startSession(deps, CTX);
    const result = await cancelSubscription(deps, CTX, { sessionId, reasonId: "switching" });
    expect(result).toMatchObject({ mode: "immediately", endsOn: null });
    expect(s.cancels[0]).toMatchObject({ mode: "immediately", feedback: "switched_service" });
  });

  it("is idempotent and refuses to cancel a session that accepted an offer", async () => {
    const { s, deps } = setup();
    const a = await startSession(deps, CTX);
    await cancelSubscription(deps, CTX, { sessionId: a.sessionId, reasonId: "too_expensive" });
    const again = await cancelSubscription(deps, CTX, { sessionId: a.sessionId, reasonId: "too_expensive" });
    expect(again.idempotent).toBe(true);
    expect(s.cancels).toHaveLength(1);

    const fresh = setup();
    const b = await startSession(fresh.deps, CTX);
    await acceptOffer(fresh.deps, CTX, { sessionId: b.sessionId, reasonId: "too_expensive" });
    await expectWidgetError(cancelSubscription(fresh.deps, CTX, { sessionId: b.sessionId, reasonId: "too_expensive" }), 409, "already_saved");
    await expectWidgetError(
      acceptOffer(deps, CTX, { sessionId: a.sessionId, reasonId: "too_expensive" }),
      409,
      "already_canceled",
    );
  });
});
