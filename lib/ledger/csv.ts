/**
 * The ledger as CSV (Dashboard → Saves ledger → Export CSV). RFC 4180
 * quoting, CRLF line ends, and spreadsheet-formula protection: a text cell
 * that starts with = + - @ (or a tab / CR) gets a leading apostrophe, so a
 * customer email like "=HYPERLINK(…)" can't run as a formula in Excel or
 * Google Sheets.
 */
import { describeOfferRecord } from "@/lib/flows/describe";

export type LedgerCsvRow = {
  receipt_number: string;
  type: "cancel" | "dunning";
  status: string;
  customer_email: string | null;
  stripe_customer_id: string;
  stripe_subscription_id: string | null;
  stripe_invoice_id: string | null;
  offer: Record<string, unknown> | null;
  attributed_via: string | null;
  saved_mrr_cents: number;
  recovered_amount_cents: number;
  currency: string;
  fee_cents: number;
  clawed_back_cents: number;
  fee_months: number;
  lost_reason: string | null;
  verified_at: string | null;
  created_at: string;
};

export const CSV_HEADER = [
  "receipt_number",
  "type",
  "status",
  "customer_email",
  "stripe_customer_id",
  "stripe_subscription_id",
  "verifying_invoice",
  "offer_or_attribution",
  "saved_mrr",
  "recovered_amount",
  "currency",
  "fee_months",
  "fees_earned_usd",
  "clawed_back_usd",
  "lost_reason",
  "verified_at",
  "created_at",
] as const;

const FORMULA_START = /^[=+\-@\t\r]/;

export function csvCell(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "";
  let text = value;
  if (FORMULA_START.test(text)) text = `'${text}`;
  if (/[",\r\n]/.test(text) || text !== text.trim()) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

/** 123456 -> "1234.56" (no currency symbol, so spreadsheets read it as a number). */
export function centsToDecimal(cents: number): string {
  const n = Math.trunc(Number(cents));
  const sign = n < 0 ? "-" : "";
  const abs = Math.abs(n);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

const ATTRIBUTION: Record<string, string> = { update_link: "Card-update link", unquit_retry: "unquit retry" };

export function ledgerToCsv(rows: readonly LedgerCsvRow[]): string {
  const lines = [CSV_HEADER.join(",")];
  for (const r of rows) {
    const cells: (string | number | null)[] = [
      r.receipt_number,
      r.type,
      r.status,
      r.customer_email,
      r.stripe_customer_id,
      r.stripe_subscription_id,
      r.stripe_invoice_id,
      r.type === "cancel" ? describeOfferRecord(r.offer) : (ATTRIBUTION[r.attributed_via ?? ""] ?? r.attributed_via),
      r.type === "cancel" ? centsToDecimal(r.saved_mrr_cents) : null,
      r.type === "dunning" ? centsToDecimal(r.recovered_amount_cents) : null,
      r.currency.toUpperCase(),
      r.fee_months,
      centsToDecimal(r.fee_cents),
      centsToDecimal(r.clawed_back_cents),
      r.lost_reason,
      r.verified_at,
      r.created_at,
    ];
    lines.push(cells.map((c) => csvCell(c)).join(","));
  }
  return lines.join("\r\n") + "\r\n";
}
