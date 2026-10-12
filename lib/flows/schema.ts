import type { CancelMode, FlowConfig, FlowTemplateId, OfferConfig, ReasonConfig } from "@/widget/types";
import { DEFAULT_CANCEL_MODE, DEFAULT_FLOW, DEFAULT_OFFER_COOLDOWN_DAYS } from "./templates";

/**
 * Validation for a founder's flow config. Used by the editor's save route
 * AND whenever a stored row is read, so a bad row can never reach Stripe.
 */

export const LIMITS = {
  maxReasons: 10,
  maxLabel: 80,
  discountPercent: { min: 5, max: 90 }, // 100% would mean $0 invoices, which never verify
  discountMonths: { min: 1, max: 12 },
  pauseMonths: { min: 1, max: 3 },
  cooldownDays: { min: 0, max: 3650 },
} as const;

const TEMPLATE_IDS: readonly FlowTemplateId[] = ["discount_first", "pause_first", "balanced", "custom"];
const REASON_ID = /^[a-z0-9_]{1,40}$/;
const PRICE_ID = /^(price|plan)_[A-Za-z0-9_]{1,200}$/;

export type ParseResult<T> = { ok: true; value: T } | { ok: false; errors: string[] };

function isInt(v: unknown, min: number, max: number): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= min && v <= max;
}

export function parseOffer(raw: unknown, where: string, errors: string[]): OfferConfig {
  const o = (raw ?? {}) as Record<string, unknown>;
  switch (o.type) {
    case "discount": {
      const { min, max } = LIMITS.discountPercent;
      if (!isInt(o.percentOff, min, max)) errors.push(`${where}: discount must be a whole number from ${min}% to ${max}%`);
      const m = LIMITS.discountMonths;
      if (!isInt(o.months, m.min, m.max)) errors.push(`${where}: discount length must be ${m.min} to ${m.max} months`);
      return { type: "discount", percentOff: Number(o.percentOff), months: Number(o.months) };
    }
    case "pause": {
      const m = LIMITS.pauseMonths;
      if (!isInt(o.months, m.min, m.max)) errors.push(`${where}: a pause must be ${m.min} to ${m.max} months`);
      return { type: "pause", months: Number(o.months) };
    }
    case "downgrade": {
      const priceId = typeof o.priceId === "string" ? o.priceId.trim() : "";
      if (!PRICE_ID.test(priceId)) errors.push(`${where}: a downgrade needs a Stripe price id (price_…)`);
      return { type: "downgrade", priceId };
    }
    case "none":
      return { type: "none" };
    default:
      errors.push(`${where}: unknown offer type`);
      return { type: "none" };
  }
}

export function parseFlowConfig(raw: unknown): ParseResult<FlowConfig> {
  const errors: string[] = [];
  const input = (raw ?? {}) as Record<string, unknown>;

  const template = TEMPLATE_IDS.includes(input.template as FlowTemplateId) ? (input.template as FlowTemplateId) : "custom";

  const cancelMode: CancelMode = input.cancelMode === "immediately" ? "immediately" : DEFAULT_CANCEL_MODE;
  if (input.cancelMode !== undefined && input.cancelMode !== "immediately" && input.cancelMode !== "period_end") {
    errors.push("cancel mode must be period_end or immediately");
  }

  const cd = LIMITS.cooldownDays;
  const offerCooldownDays = input.offerCooldownDays === undefined ? DEFAULT_OFFER_COOLDOWN_DAYS : Number(input.offerCooldownDays);
  if (!isInt(offerCooldownDays, cd.min, cd.max)) errors.push(`offer limit must be ${cd.min} to ${cd.max} days`);

  const reasons: ReasonConfig[] = [];
  if (!Array.isArray(input.reasons) || input.reasons.length === 0) {
    errors.push("add at least one reason");
  } else if (input.reasons.length > LIMITS.maxReasons) {
    errors.push(`at most ${LIMITS.maxReasons} reasons`);
  } else {
    const seen = new Set<string>();
    input.reasons.forEach((item, i) => {
      const r = (item ?? {}) as Record<string, unknown>;
      const where = `reason ${i + 1}`;
      const id = typeof r.id === "string" ? r.id : "";
      const label = typeof r.label === "string" ? r.label.trim() : "";
      if (!REASON_ID.test(id)) errors.push(`${where}: id must be lowercase letters, numbers or _`);
      else if (seen.has(id)) errors.push(`${where}: duplicate id "${id}"`);
      seen.add(id);
      if (label.length < 1 || label.length > LIMITS.maxLabel) errors.push(`${where}: label must be 1 to ${LIMITS.maxLabel} characters`);
      reasons.push({ id, label, freeText: r.freeText === true, offer: parseOffer(r.offer, where, errors) });
    });
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: { template, reasons, cancelMode, offerCooldownDays } };
}

/** Row shape of `public.flows`. */
export type FlowRow = {
  template: string;
  reasons: unknown;
  cancel_mode: string;
  offer_cooldown_days: number;
};

/** A stored row, or the default flow when there's none (or it's invalid). */
export function flowFromRow(row: FlowRow | null | undefined): FlowConfig {
  if (!row) return DEFAULT_FLOW;
  const parsed = parseFlowConfig({
    template: row.template,
    reasons: row.reasons,
    cancelMode: row.cancel_mode,
    offerCooldownDays: row.offer_cooldown_days,
  });
  if (!parsed.ok) {
    console.warn("[flows] stored flow is invalid, using the default", parsed.errors);
    return DEFAULT_FLOW;
  }
  return parsed.value;
}

export function flowToRow(flow: FlowConfig): FlowRow {
  return {
    template: flow.template,
    reasons: flow.reasons,
    cancel_mode: flow.cancelMode,
    offer_cooldown_days: flow.offerCooldownDays,
  };
}
