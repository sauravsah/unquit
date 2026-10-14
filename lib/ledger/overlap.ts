/**
 * Overlap pricing: one end-customer invoice that earns BOTH a cancel-save fee
 * and a failed-payment recovery fee.
 *
 *   A customer accepted a cancel-flow offer (cancel save: 20% of saved MRR
 *   for up to 3 paid invoices). Inside that window one of their renewals
 *   fails, and Unquit recovers it (dunning save). Before 0011 both fees were
 *   charged in full on that invoice (20% + 10%). Now:
 *
 *     cancel-save fee on the invoice   20%  (unchanged, in full)
 *     recovery fee on the invoice       5%  (OVERLAP_RECOVERY_RATE, not 10%)
 *
 * "Inside the window" is proven by the ledger itself: a cancel save only ever
 * gets a fee line for its first 3 qualifying paid invoices, so a recovery
 * line and a (non-zero) cancel-save line on the SAME invoice is exactly an
 * overlap. Outside an overlap nothing changes.
 *
 * Order-independent and idempotent: it runs after every paid invoice
 * (lib/saves/verify.ts processPaidInvoice, which the invoice.paid webhook
 * calls after the dunning recovery is recorded), and the reduction is a
 * compare-and-set, so it happens once whichever line was written first.
 * If the recovery line was already billed, lowering it makes the next
 * statement credit the difference (lib/billing/statement.ts creditOwedCents).
 * The $299 cap and clawbacks then apply to the reduced line as to any other.
 */
import { overlapRecoveryFeeCents } from "@/lib/pricing";
import type { LedgerRepo, SaveRow } from "./types";

export type OverlapResult = { reduced: { lineId: string; saveId: string; fromCents: number; toCents: number; overlapSaveId: string }[] };

async function refreshSaveFee(repo: LedgerRepo, saveId: string): Promise<void> {
  const lines = await repo.linesForSave(saveId);
  const total = lines.reduce((acc, l) => acc + Math.max(0, Number(l.amount_cents) - Number(l.clawed_back_cents ?? 0)), 0);
  await repo.setSaveFee(saveId, total);
}

/** Applies overlap pricing to every recovery line on `invoiceId`. Safe to call any number of times. */
export async function applyOverlapPricing(repo: LedgerRepo, accountId: string, invoiceId: string, at: Date): Promise<OverlapResult> {
  const result: OverlapResult = { reduced: [] };
  const lines = await repo.linesForInvoice(accountId, invoiceId);
  if (lines.length < 2) return result;

  const saves = new Map<string, SaveRow>();
  for (const id of new Set(lines.map((l) => l.save_id))) {
    const save = await repo.getSave(id);
    if (save && save.account_id === accountId) saves.set(id, save);
  }

  // The cancel save whose fee window this invoice is in.
  const cancelLine = lines.find((l) => saves.get(l.save_id)?.type === "cancel" && Number(l.amount_cents) > 0);
  if (!cancelLine) return result;
  const cancelSave = saves.get(cancelLine.save_id)!;

  for (const line of lines) {
    const save = saves.get(line.save_id);
    if (!save || save.type !== "dunning" || line.overlap_save_id) continue;
    const recovered = Number(save.recovered_amount_cents) || Number(line.invoice_amount_paid_cents ?? 0);
    const reduced = overlapRecoveryFeeCents(Math.max(0, Math.trunc(recovered)));
    const from = Number(line.amount_cents);
    if (reduced > from) continue; // never raises a fee
    const won = await repo.reduceLineForOverlap(line.id, { amountCents: reduced, overlapSaveId: cancelSave.id, at: at.toISOString() });
    if (!won) continue;
    await refreshSaveFee(repo, save.id);
    await repo.addEvent({
      accountId,
      saveId: save.id,
      kind: "overlap_reduced",
      detail: { invoice: invoiceId, from_cents: from, fee_cents: reduced, overlap_save_id: cancelSave.id, receipt: cancelSave.receipt_number },
      dedupeKey: `overlap_reduced:${line.id}`,
      occurredAt: at.toISOString(),
    });
    result.reduced.push({ lineId: line.id, saveId: save.id, fromCents: from, toCents: reduced, overlapSaveId: cancelSave.id });
  }
  return result;
}
