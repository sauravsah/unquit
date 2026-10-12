import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { DashboardShell } from "@/components/DashboardShell";
import { Paper, Row, Rule } from "@/components/Paper";
import { PrintButton } from "@/components/PrintButton";
import { getOrCreateAccount } from "@/lib/accounts";
import { loadStatement } from "@/lib/billing/dashboard";
import { loadRunningTotal } from "@/lib/ledger/dashboard";
import { monthFromSlug, monthKey, monthLabel } from "@/lib/ledger/fees";
import { formatCents, MONTHLY_FEE_CAP_CENTS } from "@/lib/pricing";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

/**
 * A month's statement: every fee line it billed, the cap, credits and the
 * total, with a link to the Stripe invoice. Unquit's monthly invoice links
 * here. The current month shows the running statement.
 */
export default async function StatementPage({ params }: { params: { month: string } }) {
  const month = monthFromSlug(params.month);
  if (!month) notFound();

  const supabase = createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect(`/login?next=/dashboard/billing/${params.month}`);
  const account = await getOrCreateAccount(supabase, user);

  const current = month === monthKey(new Date());
  const { period, lines } = await loadStatement(supabase, account.id, month);
  if (!period && !current) {
    return (
      <DashboardShell email={user.email} active="/dashboard/billing">
        <Paper>
          <h1 className="text-lg font-semibold text-ink">No statement for {monthLabel(month)}</h1>
          <p className="mt-2 text-sm text-neutral-600">
            Statements are made on the 1st for the month before. {month > monthKey(new Date()) ? "This month hasn't happened yet." : "There was nothing to bill."}
          </p>
          <Link href="/dashboard/billing" className="mt-4 inline-block text-sm font-medium text-brand hover:text-brand-dark">
            ← Billing
          </Link>
        </Paper>
      </DashboardShell>
    );
  }

  const running = !period ? await loadRunningTotal(supabase, account.id) : null;
  const t = period
    ? {
        cancel: Number(period.cancel_fees_cents),
        dunning: Number(period.dunning_fees_cents),
        gross: Number(period.gross_cents),
        cap: Number(period.cap_discount_cents),
        credit: Number(period.credit_applied_cents),
        total: Number(period.total_cents),
        capCents: Number(period.cap_cents),
      }
    : {
        cancel: running!.cancelFeesCents,
        dunning: running!.dunningFeesCents,
        gross: running!.grossCents,
        cap: running!.capDiscountCents,
        credit: running!.creditAppliedCents,
        total: running!.totalCents,
        capCents: MONTHLY_FEE_CAP_CENTS,
      };

  const status = !period
    ? "In progress: this statement is billed on the 1st"
    : period.status === "zero"
      ? "Nothing to pay this month"
      : period.status === "invoiced"
        ? `Invoiced · ${period.invoice_status === "paid" ? "paid" : period.invoice_status === "open" ? "due" : (period.invoice_status ?? "")}`
        : "Being prepared";

  return (
    <DashboardShell email={user.email} active="/dashboard/billing">
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3 print:hidden">
        <Link href="/dashboard/billing" className="text-sm font-medium text-neutral-600 hover:text-ink">
          ← Billing
        </Link>
        <div className="flex items-center gap-3">
          {period?.hosted_invoice_url ? (
            <a href={period.hosted_invoice_url} target="_blank" rel="noreferrer" className="text-sm font-medium text-brand hover:text-brand-dark">
              Stripe invoice ↗
            </a>
          ) : null}
          <PrintButton />
        </div>
      </div>

      <Paper>
        <header className="flex items-start justify-between gap-4">
          <div>
            <p className="text-lg font-semibold tracking-tight text-ink">
              unquit<span className="text-brand">.</span>
            </p>
            <p className="mt-0.5 text-xs uppercase tracking-widest text-neutral-500">Statement</p>
          </div>
          <div className="text-right">
            <p className="text-base font-semibold text-ink">{monthLabel(month)}</p>
            <p className="mt-1 text-xs text-neutral-500">{status}</p>
            {period?.stripe_invoice_id ? <p className="font-mono text-xs text-neutral-400">{period.stripe_invoice_id}</p> : null}
          </div>
        </header>

        <Rule />

        <table className="w-full text-sm">
          <thead className="text-xs text-neutral-500">
            <tr>
              <th className="py-1 text-left font-medium">Receipt</th>
              <th className="py-1 text-left font-medium">For</th>
              <th className="py-1 text-right font-medium">Fee</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-dashed divide-neutral-200">
            {lines.length === 0 ? (
              <tr>
                <td colSpan={3} className="py-6 text-center text-neutral-500">
                  No fees {period ? "this month" : "yet this month"}.
                </td>
              </tr>
            ) : (
              lines.map((l) => {
                const net = Number(l.amount_cents) - Number(l.clawed_back_cents);
                return (
                  <tr key={l.id}>
                    <td className="py-2 align-top font-mono text-xs">
                      {l.saves ? (
                        <Link href={`/dashboard/saves/${l.saves.receipt_number}`} className="text-brand hover:text-brand-dark">
                          {l.saves.receipt_number}
                        </Link>
                      ) : null}
                    </td>
                    <td className="py-2 align-top">
                      {l.saves?.type === "dunning" ? "Failed-payment recovery (10%)" : `Cancel save, month ${l.month_index} (20%)`}
                      <span className="block text-xs text-neutral-500">{l.saves?.customer_email ?? l.saves?.stripe_customer_id}</span>
                    </td>
                    <td className="py-2 text-right align-top tabular-nums">
                      {formatCents(net)}
                      {Number(l.clawed_back_cents) > 0 ? (
                        <span className="block text-xs text-red-700">after {formatCents(Number(l.clawed_back_cents))} clawed back</span>
                      ) : null}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>

        <Rule />

        <dl>
          <Row label="Cancel saves">{formatCents(t.cancel)}</Row>
          <Row label="Failed-payment recoveries">{formatCents(t.dunning)}</Row>
          <Row label="Subtotal">{formatCents(t.gross)}</Row>
          {t.cap > 0 ? <Row label={`Monthly cap (${formatCents(t.capCents)})`}>−{formatCents(t.cap)}</Row> : null}
          {t.credit > 0 ? <Row label="Credit for refunds on earlier statements">−{formatCents(t.credit)}</Row> : null}
          <div className="mt-2 border-t border-neutral-300 pt-2">
            <Row label={period ? "Total" : "Total so far"} strong>
              {formatCents(t.total)}
            </Row>
          </div>
        </dl>

        <Rule />
        <p className="text-xs leading-relaxed text-neutral-500">
          Each line is a verified save with its own receipt. Held lines (open disputes or chargebacks) aren&apos;t billed until they&apos;re settled, and
          join the next statement if they stand. Refunds on fees already billed come back as a credit on the next statement.
        </p>
      </Paper>
    </DashboardShell>
  );
}
