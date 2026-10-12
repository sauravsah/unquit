import type Stripe from "stripe";

type Expandable = string | { id: string } | null | undefined;

/** Stripe fields can be an id string or an expanded object. Return the id. */
export function idOf(value: Expandable): string | null {
  if (!value) return null;
  return typeof value === "string" ? value : value.id;
}

/**
 * The subscription an invoice belongs to.
 * Newer API versions put it at `invoice.parent.subscription_details.subscription`;
 * older ones at `invoice.subscription`. Support both, because Connect events
 * are rendered in the API version of the webhook endpoint.
 */
export function invoiceSubscriptionId(invoice: Stripe.Invoice): string | null {
  const fromParent = idOf(invoice.parent?.subscription_details?.subscription as Expandable);
  if (fromParent) return fromParent;
  const legacy = (invoice as unknown as { subscription?: Expandable }).subscription;
  return idOf(legacy);
}

export function toIso(unixSeconds: number | null | undefined): string | null {
  return typeof unixSeconds === "number" ? new Date(unixSeconds * 1000).toISOString() : null;
}
