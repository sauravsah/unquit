import type { FlowConfig, FlowTemplateId, OfferConfig, ReasonConfig } from "@/widget/types";

/**
 * The default exit-survey reasons and the three starter templates.
 * Templates never use "downgrade" because that needs one of the founder's
 * own Stripe price ids; founders add it in the editor.
 */

export const DEFAULT_REASONS: readonly { id: string; label: string; freeText?: boolean }[] = [
  { id: "too_expensive", label: "Too expensive" },
  { id: "not_using", label: "Not using it enough" },
  { id: "missing_feature", label: "Missing a feature" },
  { id: "switching", label: "Switching to another tool" },
  { id: "technical_issues", label: "Technical issues" },
  { id: "other", label: "Other", freeText: true },
];

const discount = (percentOff: number, months: number): OfferConfig => ({ type: "discount", percentOff, months });
const pause = (months: number): OfferConfig => ({ type: "pause", months });

type OfferMap = Record<string, OfferConfig>;

const TEMPLATE_OFFERS: Record<Exclude<FlowTemplateId, "custom">, OfferMap> = {
  discount_first: {
    too_expensive: discount(30, 3),
    not_using: discount(25, 2),
    missing_feature: discount(20, 2),
    switching: discount(30, 3),
    technical_issues: discount(20, 1),
    other: discount(20, 2),
  },
  pause_first: {
    too_expensive: pause(2),
    not_using: pause(3),
    missing_feature: pause(2),
    switching: pause(1),
    technical_issues: pause(1),
    other: pause(1),
  },
  balanced: {
    too_expensive: discount(30, 3),
    not_using: pause(2),
    missing_feature: discount(20, 2),
    switching: discount(25, 3),
    technical_issues: pause(1),
    other: discount(20, 2),
  },
};

export const TEMPLATES: readonly { id: Exclude<FlowTemplateId, "custom">; name: string; description: string }[] = [
  { id: "discount_first", name: "Discount-first", description: "Lead with a discount for almost every reason." },
  { id: "pause_first", name: "Pause-first", description: "Offer a break instead of a goodbye. No revenue given away." },
  { id: "balanced", name: "Balanced", description: "Discounts for price and competitors, pauses for low usage." },
];

export const DEFAULT_CANCEL_MODE = "period_end" as const;
export const DEFAULT_OFFER_COOLDOWN_DAYS = 90;

/**
 * Applies a template's offers to a reason list. Reasons the template knows
 * get its offer; custom reasons (founder-added) keep the offer they had.
 */
export function applyTemplate(template: Exclude<FlowTemplateId, "custom">, reasons: readonly ReasonConfig[]): ReasonConfig[] {
  const offers = TEMPLATE_OFFERS[template];
  return reasons.map((r) => ({ ...r, offer: offers[r.id] ? { ...offers[r.id]! } : r.offer }));
}

export function templateFlow(template: Exclude<FlowTemplateId, "custom"> = "balanced"): FlowConfig {
  const reasons: ReasonConfig[] = DEFAULT_REASONS.map((r) => ({
    id: r.id,
    label: r.label,
    freeText: r.freeText === true,
    offer: { type: "none" },
  }));
  return {
    template,
    reasons: applyTemplate(template, reasons),
    cancelMode: DEFAULT_CANCEL_MODE,
    offerCooldownDays: DEFAULT_OFFER_COOLDOWN_DAYS,
  };
}

/** The flow every account gets until its founder saves one. */
export const DEFAULT_FLOW: FlowConfig = templateFlow("balanced");
