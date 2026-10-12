/**
 * Types shared by the embeddable widget (browser), the flow editor preview
 * and the server API. Nothing in here may import Node or server-only code:
 * this file is bundled into public/widget.js.
 */

/** What a founder can attach to an exit-survey reason. */
export type OfferConfig =
  | { type: "discount"; percentOff: number; months: number }
  | { type: "pause"; months: number }
  | { type: "downgrade"; priceId: string }
  | { type: "none" };

export type OfferType = OfferConfig["type"];

/** One exit-survey answer, as stored in `flows.reasons`. */
export type ReasonConfig = {
  /** Stable slug, e.g. `too_expensive`. Stored on cancel_sessions.reason. */
  id: string;
  label: string;
  /** Show a free-text box when this reason is picked ("Other"). */
  freeText?: boolean;
  offer: OfferConfig;
};

export type FlowTemplateId = "discount_first" | "pause_first" | "balanced" | "custom";
export type CancelMode = "period_end" | "immediately";

/** A founder's whole cancel flow (one row of the `flows` table). */
export type FlowConfig = {
  template: FlowTemplateId;
  reasons: ReasonConfig[];
  cancelMode: CancelMode;
  /** At most one accepted offer per subscription within this many days. */
  offerCooldownDays: number;
};

/**
 * An offer as the end customer sees it. Built on the server from the
 * founder's config plus the live subscription; the server re-derives it on
 * accept, so nothing here is trusted when it comes back.
 */
export type OfferView =
  | { type: "discount"; percentOff: number; months: number }
  | { type: "pause"; months: number; resumesOn: string }
  | { type: "downgrade"; planName: string; amountLabel: string };

export type ReasonView = { id: string; label: string; freeText: boolean };

/** Response of POST /api/widget/session. */
export type SessionConfig = {
  sessionId: string;
  /** False when the abuse guard kicked in: survey, then straight to cancel. */
  offersEnabled: boolean;
  cancelMode: CancelMode;
  /** Formatted end of the current period, for "access until …" copy. */
  periodEndsOn: string | null;
  reasons: ReasonView[];
  /** reason id -> offer to show, or null for "no offer". */
  offers: Record<string, OfferView | null>;
};

export type AcceptResult = { outcome: "saved"; offer: OfferView; idempotent?: boolean };
export type CancelResult = { outcome: "canceled"; mode: CancelMode; endsOn: string | null; idempotent?: boolean };

export type WidgetOutcome =
  | { outcome: "saved"; offer: OfferView }
  | { outcome: "canceled"; mode: CancelMode; endsOn: string | null }
  | { outcome: "dismissed" };

/** The widget's three network calls, swappable for a mock in the editor preview. */
export type WidgetApi = {
  session(): Promise<SessionConfig>;
  accept(input: { sessionId: string; reasonId: string; reasonDetail: string }): Promise<AcceptResult>;
  cancel(input: { sessionId: string; reasonId: string; reasonDetail: string }): Promise<CancelResult>;
};
