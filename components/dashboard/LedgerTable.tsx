"use client";

import { StatusPill } from "@/components/ui/badge";
import { DataTable, type Column } from "@/components/ui/data-table";
import { EmptyState } from "@/components/ui/empty-state";
import type { LedgerRow } from "@/lib/dashboard";
import { describeOfferRecord } from "@/lib/flows/describe";
import { formatCents } from "@/lib/pricing";

const date = (iso: string) => new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });

const COLUMNS: Column<LedgerRow>[] = [
  {
    id: "receipt",
    header: "Receipt",
    primary: true,
    sortValue: (r) => r.receipt_number,
    cell: (r) => <span className="font-mono text-xs font-medium text-foreground">{r.receipt_number}</span>,
  },
  {
    id: "type",
    header: "Type",
    sortValue: (r) => r.type,
    cell: (r) => <span className="capitalize text-muted-foreground">{r.type}</span>,
  },
  {
    id: "customer",
    header: "Customer",
    hideOnMobile: true,
    cell: (r) => <span className="font-mono text-xs text-muted-foreground">{r.stripe_customer_id}</span>,
  },
  {
    id: "offer",
    header: "Offer",
    hideOnMobile: true,
    cell: (r) => <span className="text-muted-foreground">{r.type === "cancel" ? describeOfferRecord(r.offer) : "—"}</span>,
  },
  {
    id: "saved",
    header: "Saved",
    align: "right",
    sortValue: (r) => Number(r.type === "cancel" ? r.saved_mrr_cents : r.recovered_amount_cents),
    cell: (r) => (
      <span className="tabular-nums font-medium text-foreground">
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
    cell: (r) => <span className="tabular-nums text-muted-foreground">{formatCents(Number(r.fee_cents))}</span>,
  },
  {
    id: "status",
    header: "Status",
    sortValue: (r) => r.status,
    cell: (r) => <StatusPill status={r.status} />,
  },
  {
    id: "date",
    header: "Date",
    sortValue: (r) => r.verified_at ?? r.created_at,
    cell: (r) => <span className="whitespace-nowrap text-muted-foreground">{date(r.verified_at ?? r.created_at)}</span>,
  },
];

/** The saves ledger: every save with its receipt number, fee and status. */
export function LedgerTable({ rows }: { rows: LedgerRow[] }) {
  return (
    <DataTable
      caption="Saves ledger"
      columns={COLUMNS}
      rows={rows}
      getRowId={(r) => r.id}
      empty={
        <EmptyState
          art="receipts"
          title="No saves yet"
          description="When a customer accepts an offer and pays their next invoice, the save and its receipt show up here."
        />
      }
    />
  );
}
