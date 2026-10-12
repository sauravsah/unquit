import { redirect } from "next/navigation";
import { ConnectFirst, DashboardShell } from "@/components/DashboardShell";
import { StatCard } from "@/components/StatCard";
import { getOrCreateAccount } from "@/lib/accounts";
import { loadDunningDashboard, type DunningCaseView } from "@/lib/dunning/dashboard";
import { CATEGORY_LABELS, describeDeclineCode } from "@/lib/dunning/declines";
import { MONTHLY_FEE_CAP_CENTS, formatCents } from "@/lib/pricing";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { DunningEditor } from "./DunningEditor";

export const dynamic = "force-dynamic";

export default async function DunningPage() {
  const supabase = createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login?next=/dashboard/dunning");

  const account = await getOrCreateAccount(supabase, user);
  const connected = account.stripe_connection_status === "connected" && !!account.stripe_account_id;
  if (!connected) {
    return (
      <DashboardShell email={user.email} active="/dashboard/dunning" showTabs={false}>
        <ConnectFirst />
      </DashboardShell>
    );
  }

  const data = await loadDunningDashboard(supabase, account.id);
  const defaultCompany = account.name && !account.name.includes("@") ? account.name : "";

  return (
    <DashboardShell email={user.email} active="/dashboard/dunning">
      <div className="space-y-8">
        <section>
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-2xl font-semibold tracking-tight text-ink">Failed payments</h1>
            <span
              className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${
                data.settings.enabled ? "bg-brand-light text-brand-dark" : "bg-neutral-100 text-neutral-600"
              }`}
            >
              {data.settings.enabled ? "Emails on" : "Emails off"}
            </span>
          </div>
          <p className="mt-1 max-w-2xl text-sm text-neutral-500">
            When a renewal fails, unquit emails the customer a link to update their card and pays the invoice straight away. You pay
            10% of what comes back through unquit&apos;s link or retry. Payments Stripe recovers on its own are free.
          </p>
        </section>

        <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <StatCard
            label="Open cases"
            value={String(data.openCount)}
            hint={`${formatCents(data.openAmountCents)} waiting to be paid`}
          />
          <StatCard label="Recovered by unquit (this month)" value={formatCents(data.recoveredByUnquitThisMonthCents)} emphasis />
          <StatCard
            label="Recovered in total (this month)"
            value={formatCents(data.recoveredThisMonthCents)}
            hint="Includes Stripe's own retries (no fee)"
          />
          <StatCard
            label="Dunning fees (this month)"
            value={formatCents(data.dunningFeesThisMonthCents)}
            hint={`All fees capped at ${formatCents(MONTHLY_FEE_CAP_CENTS)}: you pay ${formatCents(data.bill.totalCents)} so far`}
          />
        </section>

        <section className="rounded-xl border border-neutral-200 bg-white">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-neutral-200 px-5 py-4">
            <h2 className="text-base font-semibold text-ink">Cases</h2>
            <span className="text-xs text-neutral-500">The 50 most recent failed invoices</span>
          </div>
          <CasesTable rows={data.cases} />
        </section>

        <DunningEditor initial={data.settings} saved={data.hasSettingsRow} defaultCompany={defaultCompany} />
      </div>
    </DashboardShell>
  );
}

const STATUS: Record<DunningCaseView["status"], { label: string; style: string }> = {
  open: { label: "Open", style: "bg-amber-100 text-amber-800" },
  recovered: { label: "Recovered", style: "bg-brand-light text-brand-dark" },
  closed: { label: "Closed", style: "bg-neutral-100 text-neutral-600" },
  failed: { label: "Lost", style: "bg-neutral-100 text-neutral-600" },
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

function CasesTable({ rows }: { rows: DunningCaseView[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="min-w-full text-left text-sm">
        <thead className="text-xs uppercase tracking-wide text-neutral-500">
          <tr>
            <th className="px-5 py-3 font-medium">Opened</th>
            <th className="px-5 py-3 font-medium">Customer</th>
            <th className="px-5 py-3 font-medium">Amount</th>
            <th className="px-5 py-3 font-medium">Decline</th>
            <th className="px-5 py-3 font-medium">Emails</th>
            <th className="px-5 py-3 font-medium">Status</th>
            <th className="px-5 py-3 font-medium">Recovered</th>
            <th className="px-5 py-3 font-medium">Fee</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-neutral-100">
          {rows.length === 0 ? (
            <tr>
              <td colSpan={8} className="px-5 py-12 text-center text-sm text-neutral-500">
                No failed payments yet. When a renewal fails, the case shows up here.
              </td>
            </tr>
          ) : (
            rows.map((row) => {
              const status = STATUS[row.status];
              const sent = row.emails.filter((e) => e.status === "sent" || e.status === "logged");
              const clicked = row.emails.some((e) => e.clicked_at);
              return (
                <tr key={row.id} className="align-top">
                  <td className="whitespace-nowrap px-5 py-3 text-neutral-500">{date(row.opened_at)}</td>
                  <td className="px-5 py-3">
                    <span className="block text-ink">{row.customer_name ?? row.customer_email ?? "—"}</span>
                    <span className="block font-mono text-xs text-neutral-500">{row.invoice_number ?? row.stripe_invoice_id}</span>
                  </td>
                  <td className="whitespace-nowrap px-5 py-3 tabular-nums text-ink">{formatCents(Number(row.amount_due_cents), row.currency)}</td>
                  <td className="px-5 py-3 text-neutral-700">
                    <span className="block">{describeDeclineCode(row.decline_code)}</span>
                    {row.decline_category ? (
                      <span className="block text-xs text-neutral-500">{CATEGORY_LABELS[row.decline_category]}</span>
                    ) : null}
                  </td>
                  <td className="px-5 py-3 text-neutral-700">
                    <span className="block tabular-nums">{sent.length} of 3 sent</span>
                    <span className="block text-xs text-neutral-500">
                      {clicked
                        ? "Link clicked"
                        : row.status === "open" && row.next_email_at
                          ? `Next ${date(row.next_email_at)}`
                          : row.sequence_stop_reason
                            ? STOP[row.sequence_stop_reason] ?? row.sequence_stop_reason
                            : ""}
                    </span>
                  </td>
                  <td className="px-5 py-3">
                    <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${status.style}`}>{status.label}</span>
                  </td>
                  <td className="px-5 py-3 text-neutral-700">
                    {row.status === "recovered" ? (
                      <>
                        <span className="block tabular-nums text-ink">
                          {formatCents(Number(row.recovered_amount_cents ?? 0), row.currency)}
                        </span>
                        <span className="block text-xs text-neutral-500">{VIA[row.recovered_via ?? "external"]}</span>
                      </>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td className="whitespace-nowrap px-5 py-3 tabular-nums text-ink">{row.feeCents > 0 ? formatCents(row.feeCents) : "—"}</td>
                </tr>
              );
            })
          )}
        </tbody>
      </table>
    </div>
  );
}
