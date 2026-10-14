import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { DashboardShell } from "@/components/DashboardShell";
import { Paper, Row, Rule, SectionLabel } from "@/components/Paper";
import { PrintButton } from "@/components/PrintButton";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { getOrCreateAccount } from "@/lib/accounts";
import { loadStatement } from "@/lib/billing/dashboard";
import { chargesForAccount } from "@/lib/billing/dodo/service";
import { loadRunningTotal } from "@/lib/ledger/dashboard";
import { monthFromSlug, monthKey, monthLabel } from "@/lib/ledger/fees";
import { formatCents, MONTHLY_FEE_CAP_CENTS, OVERLAP_RECOVERY_LABEL, OVERLAP_PRICING_SENTENCE } from "@/lib/pricing";
import { getSessionUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db";
import { Logo } from "@/components/Logo";

export const dynamic = "force-dynamic";

/**
 * A month's statement: every fee line it billed, the cap, credits and the
 * total, and the card charge (Dodo Payments) with its receipt. The current
 * month shows the running statement.
 */
export default async function StatementPage({ params }: { params: { month: string } }) {
  const month = monthFromSlug(params.month);
  if (!month) notFound();

  const db = getDb();
  const user = await getSessionUser();
  if (!user) redirect(`/login?next=/dashboard/billing/${params.month}`);
  const account = await getOrCreateAccount(db, user);

  const current = month === monthKey(new Date());
  const { period, lines } = await loadStatement(db, account.id, month);
  if (!period && !current) {
    return (
      <DashboardShell email={user.email} active="/dashboard/billing">
        <Paper>
          <SectionLabel>Statement</SectionLabel>
          <h1 className="mt-2 text-xl font-semibold tracking-tight text-foreground">No statement for {monthLabel(month)}</h1>
          <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
            Statements are made on the 1st for the month before. {month > monthKey(new Date()) ? "This month hasn't happened yet." : "There was nothing to bill."}
          </p>
          <Button asChild variant="secondary" size="sm" className="mt-6">
            <Link href="/dashboard/billing">← Billing</Link>
          </Button>
        </Paper>
      </DashboardShell>
    );
  }

  const running = !period ? await loadRunningTotal(db, account.id) : null;
  const charge = period ? (await chargesForAccount(db, account.id)).find((c) => c.billing_period_id === period.id) ?? null : null;
  const CHARGE_LABEL: Record<string, string> = {
    scheduled: "Card charge scheduled",
    awaiting_card: "Waiting for a billing card",
    processing: "Charging your card",
    retrying: "Payment failed · retrying",
    paid: "Paid",
    unpaid: "Unpaid · update your card",
    refunded: "Refunded",
    partially_refunded: "Paid · partly refunded",
  };
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

  // Recovery fees reduced to 5% because the same invoice earned a cancel-save fee.
  const overlapCents = lines
    .filter((l) => l.saves?.type === "dunning" && l.overlap_save_id)
    .reduce((a, l) => a + Math.max(0, Number(l.amount_cents) - Number(l.clawed_back_cents)), 0);

  const status = !period
    ? "In progress: this statement is billed on the 1st"
    : period.status === "zero"
      ? "Nothing to pay this month"
      : charge
        ? CHARGE_LABEL[charge.status] ?? charge.status
        : period.payment_status === "carried_forward"
          ? "Under $1 · added to the next charge"
          : period.status === "invoiced"
        ? `Invoiced · ${period.invoice_status === "paid" ? "paid" : period.invoice_status === "open" ? "due" : (period.invoice_status ?? "")}`
        : "Being prepared";

  const statusTone: "success" | "warning" | "neutral" | "info" = !period
    ? "info"
    : charge
      ? charge.status === "paid"
        ? "success"
        : charge.status === "unpaid" || charge.status === "retrying" || charge.status === "awaiting_card"
          ? "warning"
          : "neutral"
      : period.status === "invoiced"
      ? period.invoice_status === "paid"
        ? "success"
        : period.invoice_status === "open"
          ? "warning"
          : "neutral"
      : "neutral";

  return (
    <DashboardShell email={user.email} active="/dashboard/billing">
      <div className="mx-auto mb-6 flex max-w-2xl flex-wrap items-center justify-between gap-3 print:hidden">
        <Link
          href="/dashboard/billing"
          className="inline-flex items-center gap-1.5 rounded-md text-sm font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <ArrowLeft className="h-4 w-4" aria-hidden="true" />
          Billing
        </Link>
        <div className="flex flex-wrap items-center gap-2">
          {charge?.receipt_url ? (
            <Button asChild variant="ghost" size="sm">
              <a href={charge.receipt_url} target="_blank" rel="noreferrer">
                Receipt ↗<span className="sr-only"> (opens in a new tab)</span>
              </a>
            </Button>
          ) : null}
          {period?.hosted_invoice_url ? (
            <Button asChild variant="ghost" size="sm">
              <a href={period.hosted_invoice_url} target="_blank" rel="noreferrer">
                Stripe invoice ↗<span className="sr-only"> (opens in a new tab)</span>
              </a>
            </Button>
          ) : null}
          <PrintButton />
        </div>
      </div>

      <Paper>
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <Logo href={null} />
            <p className="mt-0.5 text-2xs font-medium uppercase tracking-[0.14em] text-muted-foreground">Statement</p>
          </div>
          <div className="sm:text-right">
            <h1 className="text-xl font-semibold tracking-tight text-foreground">{monthLabel(month)}</h1>
            <div className="mt-1.5">
              <Badge tone={statusTone} dot={!period ? "pulse" : true}>
                {status}
              </Badge>
            </div>
            {period?.stripe_invoice_id ? <p className="mt-1.5 break-all font-mono text-xs text-muted-foreground">{period.stripe_invoice_id}</p> : null}
          </div>
        </div>

        <Rule />

        <SectionLabel id="statement-lines">Fee lines</SectionLabel>
        <div className="-mx-1 mt-3 overflow-x-auto px-1">
        <table className="w-full min-w-[420px] text-sm" aria-labelledby="statement-lines">
          <thead className="text-2xs uppercase tracking-wider text-muted-foreground">
            <tr className="border-b border-border">
              <th scope="col" className="pb-2 text-left font-medium">Receipt</th>
              <th scope="col" className="pb-2 text-left font-medium">For</th>
              <th scope="col" className="pb-2 text-right font-medium">Fee</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-dashed divide-border">
            {lines.length === 0 ? (
              <tr>
                <td colSpan={3} className="py-8 text-center text-muted-foreground">
                  No fees {period ? "this month" : "yet this month"}.
                </td>
              </tr>
            ) : (
              lines.map((l) => {
                const net = Number(l.amount_cents) - Number(l.clawed_back_cents);
                return (
                  <tr key={l.id}>
                    <td className="py-3 pr-3 align-top font-mono text-xs">
                      {l.saves ? (
                        <Link
                          href={`/dashboard/saves/${l.saves.receipt_number}`}
                          className="rounded font-medium text-brand-text underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        >
                          {l.saves.receipt_number}
                        </Link>
                      ) : null}
                    </td>
                    <td className="py-3 pr-3 align-top text-foreground">
                      {l.saves?.type === "dunning"
                        ? l.overlap_save_id
                          ? OVERLAP_RECOVERY_LABEL
                          : "Failed-payment recovery (10%)"
                        : `Cancel save, month ${l.month_index} (20%)`}
                      <span className="block break-all text-xs text-muted-foreground">{l.saves?.customer_email ?? l.saves?.stripe_customer_id}</span>
                    </td>
                    <td className="whitespace-nowrap py-3 text-right align-top font-medium tabular-nums text-foreground">
                      {formatCents(net)}
                      {Number(l.clawed_back_cents) > 0 ? (
                        <span className="block text-xs font-normal text-danger">after {formatCents(Number(l.clawed_back_cents))} clawed back</span>
                      ) : null}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
        </div>

        <Rule />

        <dl>
          <Row label="Cancel saves">{formatCents(t.cancel)}</Row>
          <Row label="Failed-payment recoveries">{formatCents(t.dunning)}</Row>
          {overlapCents > 0 ? <Row label={`of which ${OVERLAP_RECOVERY_LABEL}`}>{formatCents(overlapCents)}</Row> : null}
          <Row label="Subtotal">{formatCents(t.gross)}</Row>
          {t.cap > 0 ? <Row label={`Monthly cap (${formatCents(t.capCents)})`}>−{formatCents(t.cap)}</Row> : null}
          {t.credit > 0 ? <Row label="Credit for refunds on earlier statements">−{formatCents(t.credit)}</Row> : null}
          {period && Number(period.carried_in_cents) > 0 ? <Row label="Carried in from earlier statements (under $1)">{formatCents(Number(period.carried_in_cents))}</Row> : null}
          <div className="mt-3 rounded-lg border border-border bg-muted/50 px-4 py-1">
            <Row label={period ? (charge ? "Charged to your card" : "Total") : "Total so far"} strong>
              {formatCents(charge ? Number(charge.amount_cents) : period && Number(period.carried_in_cents) > 0 ? Number(period.amount_due_cents) : t.total)}
            </Row>
          </div>
        </dl>

        <Rule />
        <p className="text-xs leading-relaxed text-muted-foreground">
          Each line is a verified save with its own receipt. Held lines (open disputes or chargebacks) aren&apos;t billed until they&apos;re settled, and
          join the next statement if they stand. Refunds on fees already billed come back as a credit on the next statement. Statements of $1 or
          more are charged automatically to your billing card through Dodo Payments, unquit&apos;s merchant of record; smaller amounts are added to
          the next charge. {OVERLAP_PRICING_SENTENCE}
        </p>
      </Paper>
    </DashboardShell>
  );
}
