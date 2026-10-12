import "server-only";
import type Stripe from "stripe";
import type { SupabaseClient } from "@supabase/supabase-js";
import { idOf } from "@/lib/stripe/ids";
import { completeSetupCheckout, type SavedPaymentMethod } from "./stripe-ops";

/**
 * unquit's own (platform) Stripe objects: the founder's saved card and the
 * status of their monthly invoices. Used by the Checkout success redirect
 * and by the optional platform webhook (/api/stripe/platform-webhook).
 */

export async function savePaymentMethod(admin: SupabaseClient, accountId: string, pm: SavedPaymentMethod): Promise<void> {
  const { error } = await admin
    .from("accounts")
    .update({
      billing_pm_status: "active",
      billing_pm_brand: pm.brand,
      billing_pm_last4: pm.last4 && /^\d{4}$/.test(pm.last4) ? pm.last4 : null,
      billing_pm_updated_at: new Date().toISOString(),
    })
    .eq("id", accountId)
    .eq("platform_customer_id", pm.customerId);
  if (error) throw new Error(`Saving payment method failed: ${error.message}`);
}

/** Finishes a Checkout (setup mode) session for this account. False if it wasn't theirs or isn't complete. */
export async function finishSetupSession(admin: SupabaseClient, stripe: Stripe, accountId: string, sessionId: string): Promise<boolean> {
  const { data, error } = await admin.from("accounts").select("platform_customer_id").eq("id", accountId).maybeSingle();
  if (error) throw new Error(`Loading account failed: ${error.message}`);
  const customerId = data?.platform_customer_id as string | null | undefined;
  if (!customerId) return false;
  const pm = await completeSetupCheckout(stripe, sessionId, customerId);
  if (!pm) return false;
  await savePaymentMethod(admin, accountId, pm);
  return true;
}

/** Mirrors a platform invoice's status onto its billing period. */
export async function syncPlatformInvoice(admin: SupabaseClient, invoice: Stripe.Invoice): Promise<boolean> {
  const { data, error } = await admin
    .from("billing_periods")
    .update({
      invoice_status: invoice.status ?? null,
      hosted_invoice_url: invoice.hosted_invoice_url ?? null,
      invoice_pdf_url: invoice.invoice_pdf ?? null,
    })
    .eq("stripe_invoice_id", invoice.id)
    .select("id");
  if (error) throw new Error(`Updating billing period failed: ${error.message}`);
  return (data?.length ?? 0) > 0;
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
export async function handlePlatformEvent(admin: SupabaseClient, stripe: Stripe, event: Stripe.Event): Promise<"processed" | "ignored"> {
  if (event.account || !PLATFORM_EVENTS.has(event.type)) return "ignored";
  if (event.type === "checkout.session.completed") {
    const session = event.data.object;
    if (session.mode !== "setup") return "ignored";
    const customerId = idOf(session.customer as string | { id: string } | null);
    if (!customerId) return "ignored";
    const { data, error } = await admin.from("accounts").select("id").eq("platform_customer_id", customerId).maybeSingle();
    if (error) throw new Error(`Loading account failed: ${error.message}`);
    if (!data) return "ignored";
    return (await finishSetupSession(admin, stripe, data.id as string, session.id)) ? "processed" : "ignored";
  }
  if (event.type.startsWith("invoice.")) {
    return (await syncPlatformInvoice(admin, event.data.object as Stripe.Invoice)) ? "processed" : "ignored";
  }
  return "ignored";
}
