import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { cancelSaveMonthlyFeeCents } from "@/lib/pricing";
import { billingMonthOf, decideCancelSaveVerification, type PaidInvoice, type PendingCancelSave } from "./rules";

export type VerifyResult = { verified: string[]; skipped: { id: string; reason: string }[] };

/**
 * Called from the `invoice.paid` webhook. Flips matching PENDING cancel saves
 * to VERIFIED and records the first month's fee.
 *
 * Core logic is real. Week 4 completes it:
 *   TODO(week 4): add fee lines for months 2 and 3 on the next paid invoices
 *                 of an already-verified save (cancelSaveMonthlyFeeCents(mrr, 2|3)).
 *   TODO(week 4): email the founder a save receipt (receipt_number) with a
 *                 Dispute button, via lib/email.ts.
 *   TODO(week 4): claw back the fee (status 'clawed_back', fee lines
 *                 'clawed_back') when charge.refunded lands inside the window.
 *   TODO(week 4): push verified fees to Stripe metered billing, applying the
 *                 $299 monthly cap from lib/pricing.ts.
 */
export async function verifyPendingCancelSaves(
  admin: SupabaseClient,
  accountId: string,
  invoice: PaidInvoice,
): Promise<VerifyResult> {
  const result: VerifyResult = { verified: [], skipped: [] };
  if (!invoice.subscriptionId) return result;

  const { data: pending, error } = await admin
    .from("saves")
    .select("id, type, status, stripe_subscription_id, created_at, saved_mrr_cents")
    .eq("account_id", accountId)
    .eq("type", "cancel")
    .eq("status", "pending")
    .eq("stripe_subscription_id", invoice.subscriptionId);

  if (error) throw new Error(`Loading pending saves failed: ${error.message}`);

  for (const row of (pending ?? []) as (PendingCancelSave & { saved_mrr_cents: number })[]) {
    const decision = decideCancelSaveVerification(row, invoice);
    if (!decision.verify) {
      result.skipped.push({ id: row.id, reason: decision.reason });
      continue;
    }

    const feeCents = cancelSaveMonthlyFeeCents(Number(row.saved_mrr_cents), 1);

    // `.eq("status", "pending")` makes this a compare-and-set: if two webhook
    // deliveries race, only one flips the row.
    const { data: updated, error: updateError } = await admin
      .from("saves")
      .update({
        status: "verified",
        verified_at: new Date().toISOString(),
        stripe_invoice_id: invoice.id,
        fee_cents: feeCents,
      })
      .eq("id", row.id)
      .eq("status", "pending")
      .select("id");

    if (updateError) throw new Error(`Verifying save ${row.id} failed: ${updateError.message}`);
    if (!updated || updated.length === 0) continue; // someone else verified it first

    const { error: lineError } = await admin.from("save_fee_lines").upsert(
      {
        save_id: row.id,
        account_id: accountId,
        month_index: 1,
        billing_month: billingMonthOf(invoice.createdUnix),
        stripe_invoice_id: invoice.id,
        amount_cents: feeCents,
      },
      { onConflict: "save_id,month_index", ignoreDuplicates: true },
    );
    if (lineError) throw new Error(`Recording fee line for save ${row.id} failed: ${lineError.message}`);

    result.verified.push(row.id);
  }

  return result;
}
