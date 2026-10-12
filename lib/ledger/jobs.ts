/**
 * The ledger's scheduled work, run by the existing daily cron
 * (/api/cron/dunning) and the monthly billing cron (/api/cron/billing).
 * Every step is idempotent, so running it twice in a day changes nothing.
 */
import { runMonthlyBilling, type BillingDeps, type BillingRunSummary } from "@/lib/billing/service";
import { abandonStaleSessions, expirePendingSaves } from "@/lib/saves/verify";
import { sendReceiptEmails, type LedgerDeps } from "./disputes";

export type DailyLedgerSummary = {
  expiredSaves: number;
  abandonedSessions: number;
  receipts: { sent: number; failed: number };
  /** Catch-up for last month's statements (a no-op once the monthly run did them). */
  billing: BillingRunSummary | { error: string } | null;
};

export async function runDailyLedgerJobs(
  deps: LedgerDeps,
  options: { verifyWindowDays: number; billing?: BillingDeps | null; now?: Date },
): Promise<DailyLedgerSummary> {
  const now = options.now ?? deps.now?.() ?? new Date();
  const expired = await expirePendingSaves(deps.repo, now, options.verifyWindowDays);
  const abandoned = await abandonStaleSessions(deps.repo, now);
  const receipts = await sendReceiptEmails({ ...deps, now: () => now });
  let billing: DailyLedgerSummary["billing"] = null;
  if (options.billing) {
    try {
      billing = await runMonthlyBilling({ ...options.billing, now: () => now });
    } catch (error) {
      billing = { error: error instanceof Error ? error.message : String(error) };
    }
  }
  return { expiredSaves: expired.length, abandonedSessions: abandoned, receipts, billing };
}
