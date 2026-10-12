import { Download, X } from "lucide-react";
import Link from "next/link";
import { SAVE_STATUS } from "@/components/SaveStatus";
import { Button } from "@/components/ui/button";
import { Input, NativeSelect } from "@/components/ui/input";
import { filtersToQuery, type LedgerFilters } from "@/lib/ledger/dashboard";
import type { SaveStatus } from "@/lib/ledger/types";

/** The ledger's filters (a plain GET form, so they live in the URL) and CSV export. */
export function LedgerFilterForm({ filters }: { filters: LedgerFilters }) {
  const statuses = Object.entries(SAVE_STATUS) as [SaveStatus, { label: string }][];
  const active = !!(filters.type || filters.status || filters.month);
  return (
    <form method="get" action="/dashboard#ledger" className="flex flex-wrap items-center gap-2 text-sm" aria-label="Filter the ledger">
      <label className="sr-only" htmlFor="ledger-type">
        Type
      </label>
      <NativeSelect id="ledger-type" name="type" defaultValue={filters.type ?? ""} className="h-8 text-xs sm:text-xs">
        <option value="">All types</option>
        <option value="cancel">Cancel saves</option>
        <option value="dunning">Failed payments</option>
      </NativeSelect>
      <label className="sr-only" htmlFor="ledger-status">
        Status
      </label>
      <NativeSelect id="ledger-status" name="status" defaultValue={filters.status ?? ""} className="h-8 text-xs sm:text-xs">
        <option value="">All statuses</option>
        {statuses.map(([value, s]) => (
          <option key={value} value={value}>
            {s.label}
          </option>
        ))}
      </NativeSelect>
      <label className="sr-only" htmlFor="ledger-month">
        Month
      </label>
      <Input id="ledger-month" type="month" name="month" defaultValue={filters.month ?? ""} className="h-8 w-[150px] text-xs sm:text-xs" />
      <Button type="submit" size="sm">
        Filter
      </Button>
      {active ? (
        <Button asChild variant="ghost" size="sm">
          <Link href="/dashboard#ledger">
            <X className="h-3.5 w-3.5" /> Clear
          </Link>
        </Button>
      ) : null}
      {/* A plain link: the route returns a CSV download. */}
      <Button asChild variant="secondary" size="sm">
        {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
        <a href={`/api/dashboard/ledger/export${filtersToQuery(filters)}`}>
          <Download className="h-3.5 w-3.5" /> Export CSV
        </a>
      </Button>
    </form>
  );
}
