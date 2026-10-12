import type { OfferConfig } from "@/widget/types";

/** Short dashboard labels for offers, e.g. "30% off × 3 mo". */

export function describeOfferConfig(offer: OfferConfig): string {
  switch (offer.type) {
    case "discount":
      return `${offer.percentOff}% off × ${offer.months} mo`;
    case "pause":
      return `Pause ${offer.months} mo`;
    case "downgrade":
      return `Downgrade to ${offer.priceId || "…"}`;
    case "none":
      return "No offer";
  }
}

/** For a stored offer snapshot (cancel_sessions.offer_shown / saves.offer, snake_case). */
export function describeOfferRecord(record: Record<string, unknown> | null | undefined): string {
  if (!record || typeof record.type !== "string") return "—";
  switch (record.type) {
    case "discount":
      return `${Number(record.percent_off)}% off × ${Number(record.months)} mo`;
    case "pause":
      return `Pause ${Number(record.months)} mo`;
    case "downgrade":
      return `Downgrade to ${typeof record.plan_name === "string" ? record.plan_name : "cheaper plan"}`;
    default:
      return "—";
  }
}
