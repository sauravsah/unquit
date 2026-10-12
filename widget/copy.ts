import type { OfferView } from "./types";

/** Every word the end customer reads about an offer, in one place. */

export function offerHeadline(offer: OfferView): string {
  switch (offer.type) {
    case "discount":
      return `How about ${offer.percentOff}% off?`;
    case "pause":
      return "Need a break? Pause instead.";
    case "downgrade":
      return `Switch to ${offer.planName} instead?`;
  }
}

export function offerBody(offer: OfferView): string {
  switch (offer.type) {
    case "discount":
      return `Stay with us and get ${offer.percentOff}% off for the next ${plural(offer.months, "month")}. It's applied automatically, nothing else to do.`;
    case "pause":
      return `Pause your subscription for ${plural(offer.months, "month")}. You won't be charged while it's paused, and it picks up again on ${offer.resumesOn}.`;
    case "downgrade":
      return `Keep your account on the ${offer.planName} plan for ${offer.amountLabel}. Your data stays exactly where it is.`;
  }
}

export function acceptLabel(offer: OfferView): string {
  switch (offer.type) {
    case "discount":
      return `Accept ${offer.percentOff}% off`;
    case "pause":
      return `Pause for ${plural(offer.months, "month")}`;
    case "downgrade":
      return `Switch to ${offer.planName}`;
  }
}

export function savedSummary(offer: OfferView): string {
  switch (offer.type) {
    case "discount":
      return `${offer.percentOff}% off has been applied to your next ${plural(offer.months, "month")}.`;
    case "pause":
      return `Your subscription is paused. Billing resumes on ${offer.resumesOn}.`;
    case "downgrade":
      return `You're now on the ${offer.planName} plan (${offer.amountLabel}).`;
  }
}

export function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}
