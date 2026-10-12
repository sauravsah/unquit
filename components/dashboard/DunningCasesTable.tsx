"use client";

import { MousePointerClick } from "lucide-react";
import { StatusPill } from "@/components/ui/badge";
import { DataTable, type Column } from "@/components/ui/data-table";
import { EmptyState } from "@/components/ui/empty-state";
import type { DunningCaseView } from "@/lib/dunning/dashboard";
import { CATEGORY_LABELS, describeDeclineCode } from "@/lib/dunning/declines";
import { formatCents } from "@/lib/pricing";

const STATUS: Record<DunningCaseView["status"], { label: string; status: string }> = {
  open: { label: "Open", status: "open" },
  recovered: { label: "Recovered", status: "recovered" },
  closed: { label: "Closed", status: "closed" },
  failed: { label: "Lost", status: "lost" },
};

const VIA: Record<string, string> = {
  update_link: "Card-update link",
  unquit_retry: "unquit retry",
  external: "Stripe / other (no fee)",
};

const STOP: Record<string, string> = {
  paid: "stopped: paid",
  canceled: "stopped: subscription cancelled",
  completed: "sequence finished",
  no_email: "no customer email",
  invoice_closed: "stopped: invoice closed",
};

const date = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : "—");

const COLUMNS: Column<DunningCaseView>[] = [
  {
    id: "opened",
    header: "Opened",
    sortValue: (r) => r.opened_at,
    cell: (r) => <span className="whitespace-nowrap text-muted-foreground">{date(r.opened_at)}</span>,
  },
  {
    id: "customer",
    header: "Customer",
    primary: true,
    sortValue: (r) => r.customer_name ?? r.customer_email ?? "",
    cell: (r) => (
      <span>
        <span className="block text-foreground">{r.customer_name ?? r.customer_email ?? "—"}</span>
        <span className="block font-mono text-xs text-muted-foreground">{r.invoice_number ?? r.stripe_invoice_id}</span>
      </span>
    ),
  },
  {
    id: "amount",
    header: "Amount",
    align: "right",
    sortValue: (r) => Number(r.amount_due_cents),
    cell: (r) => <span className="whitespace-nowrap font-medium tabular-nums text-foreground">{formatCents(Number(r.amount_due_cents), r.currency)}</span>,
  },
  {
    id: "decline",
    header: "Decline",
    sortValue: (r) => r.decline_category ?? "",
    cell: (r) => (
      <span>
        <span className="block text-foreground">{describeDeclineCode(r.decline_code)}</span>
        {r.decline_category ? <span className="block text-xs text-muted-foreground">{CATEGORY_LABELS[r.decline_category]}</span> : null}
      </span>
    ),
  },
  {
    id: "emails",
    header: "Emails",
    hideOnMobile: true,
    cell: (r) => {
      const sent = r.emails.filter((e) => e.status === "sent" || e.status === "logged");
      const clicked = r.emails.some((e) => e.clicked_at);
      return (
        <span>
          <span className="flex items-center gap-1.5">
            <span className="flex gap-0.5" aria-hidden="true">
              {[0, 1, 2].map((i) => (
                <span key={i} className={`h-1.5 w-4 rounded-full ${i < sent.length ? "bg-brand" : "bg-muted"}`} />
              ))}
            </span>
            <span className="text-xs tabular-nums text-foreground">{sent.length} of 3 sent</span>
          </span>
          <span className="mt-0.5 flex items-center gap-1 text-xs text-muted-foreground">
            {clicked ? (
              <>
                <MousePointerClick className="h-3 w-3 text-brand-text" /> Link clicked
              </>
            ) : r.status === "open" && r.next_email_at ? (
              `Next ${date(r.next_email_at)}`
            ) : r.sequence_stop_reason ? (
              STOP[r.sequence_stop_reason] ?? r.sequence_stop_reason
            ) : (
              ""
            )}
          </span>
        </span>
      );
    },
  },
  {
    id: "status",
    header: "Status",
    sortValue: (r) => r.status,
    cell: (r) => <StatusPill status={STATUS[r.status].status} label={STATUS[r.status].label} />,
  },
  {
    id: "recovered",
    header: "Recovered",
    sortValue: (r) => (r.status === "recovered" ? Number(r.recovered_amount_cents ?? 0) : null),
    cell: (r) =>
      r.status === "recovered" ? (
        <span>
          <span className="block tabular-nums text-foreground">{formatCents(Number(r.recovered_amount_cents ?? 0), r.currency)}</span>
          <span className="block text-xs text-muted-foreground">{VIA[r.recovered_via ?? "external"]}</span>
        </span>
      ) : (
        <span className="text-muted-foreground">—</span>
      ),
  },
  {
    id: "fee",
    header: "Fee",
    align: "right",
    sortValue: (r) => r.feeCents,
    cell: (r) => <span className="whitespace-nowrap tabular-nums text-foreground">{r.feeCents > 0 ? formatCents(r.feeCents) : "—"}</span>,
  },
];

export function DunningCasesTable({ rows }: { rows: DunningCaseView[] }) {
  return (
    <DataTable
      caption="Failed payment cases"
      columns={COLUMNS}
      rows={rows}
      getRowId={(r) => r.id}
      empty={<EmptyState art="card" title="No failed payments yet" description="When a renewal fails, the case shows up here with every email and the outcome." />}
    />
  );
}
