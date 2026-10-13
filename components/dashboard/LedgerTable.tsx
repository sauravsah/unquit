"use client";

import Link from "next/link";
import { Badge, StatusPill } from "@/components/ui/badge";
import { DataTable, type Column } from "@/components/ui/data-table";
import { EmptyState } from "@/components/ui/empty-state";
import type { LedgerRow } from "@/lib/dashboard";
import { describeOfferRecord } from "@/lib/flows/describe";
import type { SaveStatus } from "@/lib/ledger/types";
import { formatCents } from "@/lib/pricing";

const date = (iso: string) => new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
const href = (r: LedgerRow) => `/dashboard/saves/${r.receipt_number}`;

/** Labels match components/SaveStatus.tsx (SAVE_STATUS). */
const STATUS_LABEL: Record<SaveStatus, string> = {
  pending: "Pending",
  verified: "Verified",
  disputed: "Disputed",
  clawed_back: "Reversed",
  lost: "Lost",
};

const COLUMNS: Column<LedgerRow>[] = [
  {
    id: "receipt",
    header: "Receipt",
    primary: true,
    sortValue: (r) => r.receipt_number,
    cell: (r) => (
      <Link href={href(r)} className="font-mono text-xs font-medium text-brand-text underline-offset-4 hover:underline">
        {r.receipt_number}
      </Link>
    ),
  },
  {
    id: "type",
    header: "Type",
    sortValue: (r) => r.type,
    cell: (r) => <span className="whitespace-nowrap text-muted-foreground">{r.type === "cancel" ? "Cancel save" : "Failed payment"}</span>,
  },
  {
    id: "customer",
    header: "Customer",
    hideOnMobile: true,
    sortValue: (r) => r.customer_email ?? r.stripe_customer_id,
    cell: (r) => (
      <span className="text-xs">
        {r.customer_email ? <span className="block text-foreground">{r.customer_email}</span> : null}
        <span className="font-mono text-muted-foreground">{r.stripe_customer_id}</span>
      </span>
    ),
  },
  {
    id: "offer",
    header: "Offer / how",
    hideOnMobile: true,
    cell: (r) => (
      <span className="text-muted-foreground">
        {r.type === "cancel" ? describeOfferRecord(r.offer) : r.attributed_via === "update_link" ? "Card-update link" : "unquit retry"}
      </span>
    ),
  },
  {
    id: "saved",
    header: "Saved",
    align: "right",
    sortValue: (r) => Number(r.type === "cancel" ? r.saved_mrr_cents : r.recovered_amount_cents),
    cell: (r) => (
      <span className="whitespace-nowrap font-medium tabular-nums text-foreground">
        {r.type === "cancel"
          ? `${formatCents(Number(r.saved_mrr_cents), r.currency)}/mo`
          : formatCents(Number(r.recovered_amount_cents), r.currency)}
      </span>
    ),
  },
  {
    id: "fee",
    header: "Fee",
    align: "right",
    sortValue: (r) => Number(r.fee_cents),
    cell: (r) => (
      <span className="whitespace-nowrap tabular-nums text-foreground">
        {formatCents(Number(r.fee_cents))}
        {r.type === "cancel" && r.fee_months > 0 ? <span className="block text-xs text-muted-foreground">{r.fee_months} of 3 months</span> : null}
        {r.held ? <span className="block text-xs text-warning">on hold</span> : null}
      </span>
    ),
  },
  {
    id: "status",
    header: "Status",
    sortValue: (r) => r.status,
    cell: (r) => (
      <span className="inline-flex flex-wrap items-center gap-1.5">
        <StatusPill status={r.status} label={STATUS_LABEL[r.status]} />
        {r.ended_at && r.status !== "lost" ? <Badge tone="outline">cancelled later</Badge> : null}
        {r.held ? (
          <Badge tone="warning" dot="pulse" title="A dispute or chargeback is open: this save's fees aren't billed until it's settled">
            fee on hold
          </Badge>
        ) : null}
        {Number(r.clawed_back_cents) > 0 && r.status !== "clawed_back" ? (
          <Badge tone="danger" title={`${formatCents(Number(r.clawed_back_cents))} of the fee clawed back`}>
            −{formatCents(Number(r.clawed_back_cents))} clawed back
          </Badge>
        ) : null}
      </span>
    ),
  },
  {
    id: "date",
    header: "Date",
    sortValue: (r) => r.verified_at ?? r.created_at,
    cell: (r) => (
      <Link href={href(r)} className="whitespace-nowrap text-muted-foreground hover:text-foreground">
        {date(r.verified_at ?? r.created_at)}
      </Link>
    ),
  },
];

/** The saves ledger: every save with its receipt, fee and status. Rows link to the receipt. */
export function LedgerTable({ rows, filtered = false }: { rows: LedgerRow[]; filtered?: boolean }) {
  return (
    <DataTable
      caption="Saves ledger"
      columns={COLUMNS}
      rows={rows}
      getRowId={(r) => r.id}
      empty={
        filtered ? (
          <EmptyState compact art="receipts" title="No saves match these filters" description="Try another month or status." />
        ) : (
          <EmptyState
            art="receipts"
            title="No saves yet"
            description="When a customer accepts an offer and pays their next invoice, the save and its receipt show up here."
          />
        )
      }
    />
  );
}
