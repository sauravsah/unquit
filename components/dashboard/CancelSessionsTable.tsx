"use client";

import Link from "next/link";
import { StatusPill } from "@/components/ui/badge";
import { DataTable, type Column } from "@/components/ui/data-table";
import { EmptyState } from "@/components/ui/empty-state";
import type { CancelSessionRow } from "@/lib/dashboard";
import { describeOfferRecord } from "@/lib/flows/describe";
import { formatCents } from "@/lib/pricing";

const OUTCOME: Record<CancelSessionRow["status"], { label: string; status: string }> = {
  started: { label: "In progress", status: "started" },
  offer_shown: { label: "Offer shown", status: "offer_shown" },
  offer_accepted: { label: "Saved", status: "saved" },
  canceled: { label: "Cancelled", status: "canceled" },
  abandoned: { label: "Closed", status: "abandoned" },
};

const COLUMNS: Column<CancelSessionRow>[] = [
  {
    id: "date",
    header: "Date",
    sortValue: (r) => r.started_at,
    cell: (r) => <span className="whitespace-nowrap text-muted-foreground">{new Date(r.started_at).toLocaleDateString("en-US", { month: "short", day: "numeric" })}</span>,
  },
  {
    id: "customer",
    header: "Customer",
    primary: true,
    cell: (r) => <span className="font-mono text-xs text-foreground">{r.stripe_customer_id}</span>,
  },
  {
    id: "reason",
    header: "Reason",
    sortValue: (r) => r.reason_label ?? r.reason ?? "",
    cell: (r) => (
      <span className="text-foreground">
        {r.reason_label ?? r.reason ?? "—"}
        {r.reason_detail ? (
          <span className="mt-0.5 block max-w-xs truncate text-xs text-muted-foreground" title={r.reason_detail}>
            “{r.reason_detail}”
          </span>
        ) : null}
      </span>
    ),
  },
  {
    id: "offer",
    header: "Offer",
    hideOnMobile: true,
    cell: (r) => <span className="text-muted-foreground">{r.offers_enabled ? describeOfferRecord(r.offer_shown) : "Skipped (offer limit)"}</span>,
  },
  {
    id: "outcome",
    header: "Outcome",
    sortValue: (r) => r.status,
    cell: (r) => <StatusPill status={OUTCOME[r.status].status} label={OUTCOME[r.status].label} />,
  },
  {
    id: "mrr",
    header: "MRR",
    align: "right",
    sortValue: (r) => (r.mrr_at_start_cents === null ? null : Number(r.mrr_at_start_cents)),
    cell: (r) => (
      <span className="tabular-nums text-foreground">{r.mrr_at_start_cents === null ? "—" : `${formatCents(Number(r.mrr_at_start_cents))}/mo`}</span>
    ),
  },
];

export function CancelSessionsTable({ rows }: { rows: CancelSessionRow[] }) {
  return (
    <DataTable
      caption="Cancel sessions"
      columns={COLUMNS}
      rows={rows}
      getRowId={(r) => r.id}
      empty={
        <EmptyState
          art="flow"
          title="No cancel attempts yet"
          description="Each time a customer opens your cancel flow, it shows up here with their reason and what happened."
          action={
            <Link href="/dashboard/test" className="text-sm font-medium text-brand-text hover:underline">
              Try the widget yourself →
            </Link>
          }
        />
      }
    />
  );
}
