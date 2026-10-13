import "server-only";
import type Stripe from "stripe";
import { attempt, queryOne, type Db } from "@/lib/db/core";
import { idOf } from "@/lib/stripe/ids";
import { completeSetupCheckout, type SavedPaymentMethod } from "./stripe-ops";

/**
 * unquit's own (platform) Stripe objects: the founder's saved card and the
 * status of their monthly invoices. Used by the Checkout success redirect
 * and by the optional platform webhook (/api/stripe/platform-webhook).
 */

export async function savePaymentMethod(db: Db, accountId: string, pm: SavedPaymentMethod): Promise<void> {
  await attempt("Saving payment method", () =>
    db.query(
      `update accounts
          set billing_pm_status = 'active', billing_pm_brand = $3, billing_pm_last4 = $4, billing_pm_updated_at = $5
        where id = $1 and platform_customer_id = $2`,
      [accountId, pm.customerId, pm.brand, pm.last4 && /^\d{4}$/.test(pm.last4) ? pm.last4 : null, new Date().toISOString()],
    ),
  );
}

/** Finishes a Checkout (setup mode) session for this account. False if it wasn't theirs or isn't complete. */
export async function finishSetupSession(db: Db, stripe: Stripe, accountId: string, sessionId: string): Promise<boolean> {
  const row = await attempt("Loading account", () =>
    queryOne<{ platform_customer_id: string | null }>(db, "select platform_customer_id from accounts where id = $1", [accountId]),
  );
  const customerId = row?.platform_customer_id;
  if (!customerId) return false;
  const pm = await completeSetupCheckout(stripe, sessionId, customerId);
  if (!pm) return false;
  await savePaymentMethod(db, accountId, pm);
  return true;
}

/** Mirrors a platform invoice's status onto its billing period. */
export async function syncPlatformInvoice(db: Db, invoice: Stripe.Invoice): Promise<boolean> {
  const rows = await attempt("Updating billing period", () =>
    db.query<{ id: string }>(
      `update billing_periods set invoice_status = $2, hosted_invoice_url = $3, invoice_pdf_url = $4
        where stripe_invoice_id = $1
        returning id`,
      [invoice.id, invoice.status ?? null, invoice.hosted_invoice_url ?? null, invoice.invoice_pdf ?? null],
    ),
  );
  return rows.length > 0;
}

export const PLATFORM_EVENTS = new Set([
  "checkout.session.completed",
  "invoice.finalized",
  "invoice.paid",
  "invoice.payment_failed",
  "invoice.voided",
  "invoice.marked_uncollectible",
]);

/** Handles one event from unquit's OWN Stripe account (not a connected account). */
export async function handlePlatformEvent(db: Db, stripe: Stripe, event: Stripe.Event): Promise<"processed" | "ignored"> {
  if (event.account || !PLATFORM_EVENTS.has(event.type)) return "ignored";
  if (event.type === "checkout.session.completed") {
    const session = event.data.object;
    if (session.mode !== "setup") return "ignored";
    const customerId = idOf(session.customer as string | { id: string } | null);
    if (!customerId) return "ignored";
    const row = await attempt("Loading account", () =>
      queryOne<{ id: string }>(db, "select id from accounts where platform_customer_id = $1", [customerId]),
    );
    if (!row) return "ignored";
    return (await finishSetupSession(db, stripe, row.id, session.id)) ? "processed" : "ignored";
  }
  if (event.type.startsWith("invoice.")) {
    return (await syncPlatformInvoice(db, event.data.object as Stripe.Invoice)) ? "processed" : "ignored";
  }
  return "ignored";
}
