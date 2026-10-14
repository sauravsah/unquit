import { CircleGauge, CreditCard, FileText, Lock, Receipt } from "lucide-react";
import Link from "next/link";
import { redirect } from "next/navigation";
import { CapProgress } from "@/components/CapProgress";
import { ConnectFirst, DashboardShell, PageHeader } from "@/components/DashboardShell";
import { Notice } from "@/components/dashboard/Notice";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/components/ui/cn";
import { EmptyState } from "@/components/ui/empty-state";
import { StatCard } from "@/components/ui/stat-card";
import { getOrCreateAccount } from "@/lib/accounts";
import { loadBillingPage } from "@/lib/billing/dashboard";
import { MIN_CHARGE_CENTS } from "@/lib/billing/dodo/policy";
import { dodoConfigured, dodoDeps } from "@/lib/billing/dodo/runtime";
import { confirmReturn, isChargeable, type ChargeStatus } from "@/lib/billing/dodo/service";
import { loadRunningTotal } from "@/lib/ledger/dashboard";
import { monthLabel, monthSlug } from "@/lib/ledger/fees";
import { formatCents, MONTHLY_FEE_CAP_CENTS } from "@/lib/pricing";
import { getSessionUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db";

export const dynamic = "force-dynamic";

const CARD_BANNERS: Record<string, { tone: "good" | "bad" | "neutral"; text: string }> = {
  saved: { tone: "good", text: "Card saved. Nothing was charged. unquit's fees will be charged to it automatically on the 1st of each month." },
  updated: { tone: "good", text: "Card updated. Any unpaid statement will be charged to it once, at the next daily run." },
  pending: { tone: "neutral", text: "Dodo Payments is still confirming your card. Refresh in a moment." },
  error: { tone: "bad", text: "We couldn't open the secure card form. Please try again." },
};

const LEGACY_INVOICE_STATUS: Record<string, { label: string; tone: "success" | "warning" | "neutral" | "danger" }> = {
  paid: { label: "Paid", tone: "success" },
  open: { label: "Due", tone: "warning" },
  draft: { label: "Preparing", tone: "neutral" },
  void: { label: "Void", tone: "neutral" },
  uncollectible: { label: "Unpaid", tone: "danger" },
};

const CHARGE_STATUS: Record<ChargeStatus | "carried_forward", { label: string; tone: "success" | "warning" | "neutral" | "danger" }> = {
  scheduled: { label: "Scheduled", tone: "neutral" },
  awaiting_card: { label: "Needs a card", tone: "warning" },
  processing: { label: "Processing", tone: "neutral" },
  retrying: { label: "Retrying", tone: "warning" },
  paid: { label: "Paid", tone: "success" },
  unpaid: { label: "Unpaid", tone: "danger" },
  refunded: { label: "Refunded", tone: "neutral" },
  partially_refunded: { label: "Partly refunded", tone: "neutral" },
  carried_forward: { label: "Carried forward", tone: "neutral" },
};

const dateLabel = (iso: string) => new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });

/** "November 1, 2026": the 1st after the running month, when its statement is charged. */
function nextChargeDate(runningMonth: string): string {
  const [y, m] = runningMonth.split("-").map(Number) as [number, number];
  return new Date(Date.UTC(y, m, 1)).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });
}

export default async function BillingPage({ searchParams }: { searchParams: { card?: string; subscription_id?: string; status?: string } }) {
  const db = getDb();
  const user = await getSessionUser();
  if (!user) redirect("/login?next=/dashboard/billing");

  const account = await getOrCreateAccount(db, user);
  const connected = account.stripe_connection_status === "connected" && !!account.stripe_account_id;

  // Back from Dodo Payments: re-read the subscription from Dodo (the webhook records it too).
  let cardState = searchParams.card;
  if ((cardState === "saved" || cardState === "updated") && searchParams.subscription_id && dodoConfigured()) {
    try {
      const ok = await confirmReturn(dodoDeps(db), account.id, searchParams.subscription_id);
      if (!ok) cardState = "pending";
    } catch (error) {
      console.error("[billing] confirming the Dodo return failed", error);
      cardState = "pending";
    }
  }

  const { account: billing, periods, charges, carriedForwardCents } = await loadBillingPage(db, account.id);
  const running = await loadRunningTotal(db, account.id);
  const hasCard = billing.billing_pm_status === "active" && isChargeable(billing.dodo_subscription_status);
  if (cardState === "saved" && !hasCard) cardState = "pending";
  const banner = cardState ? CARD_BANNERS[cardState] : undefined;
  const onHold = billing.dodo_subscription_status === "on_hold";
  const chargeByPeriod = new Map(charges.map((c) => [c.billing_period_id, c]));
  const unpaid = charges.filter((c) => c.status === "unpaid" || c.status === "awaiting_card");
  const retrying = charges.find((c) => c.status === "retrying");
  const estimateCents = running.totalCents + carriedForwardCents;
  const paidToDate = charges.filter((c) => c.status === "paid" || c.status === "partially_refunded").reduce((a, c) => a + Number(c.amount_cents) - Number(c.refunded_cents), 0);

  return (
    <DashboardShell email={user.email} active="/dashboard/billing" showTabs={connected}>
      {!connected && periods.length === 0 ? (
        <ConnectFirst />
      ) : (
        <div className="space-y-6">
          {banner ? <Notice tone={banner.tone}>{banner.text}</Notice> : null}
          {unpaid.length > 0 ? (
            <Notice tone="bad">
              {unpaid.some((c) => c.status === "unpaid")
                ? `We couldn't charge your card for ${formatCents(unpaid.reduce((a, c) => a + Number(c.amount_cents), 0))} of unquit fees. Please update your card below; we'll charge it once, at the next daily run.`
                : `Add a billing card below to pay ${formatCents(unpaid.reduce((a, c) => a + Number(c.amount_cents), 0))} of unquit fees.`}
            </Notice>
          ) : retrying?.next_attempt_at ? (
            <Notice tone="neutral">
              {`Your last payment of ${formatCents(Number(retrying.amount_cents))} didn't go through. We'll try again on ${dateLabel(retrying.next_attempt_at)}, or update your card below.`}
            </Notice>
          ) : null}

          <PageHeader
            title="Billing"
            className="mb-2"
            badge={<Badge tone="success" dot>Pay per save</Badge>}
            description={
              <>
                No base fee. You pay 20% of saved MRR for a saved customer&apos;s first 3 paid months, and 10% of failed payments unquit recovers.
                Never more than {formatCents(MONTHLY_FEE_CAP_CENTS)} in a month. Charged automatically to your card on the 1st for the month before,
                through Dodo Payments.
              </>
            }
          />

          <section aria-label="This month and payment method" className="grid gap-6 lg:grid-cols-3">
            <Card className="overflow-hidden lg:col-span-2">
              <CardHeader>
                <div>
                  <CardTitle>{monthLabel(running.month)} so far</CardTitle>
                  <CardDescription>Unbilled fees for the running month, after the cap and credits</CardDescription>
                </div>
                <Link
                  href={`/dashboard/billing/${monthSlug(running.month)}`}
                  className="rounded text-xs font-medium text-brand-text underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  See the running statement →
                </Link>
              </CardHeader>
              <CardContent>
                <p className="text-4xl font-semibold tabular-nums tracking-tight text-foreground">{formatCents(running.totalCents)}</p>
                <div className="mt-4">
                  <CapProgress cents={running.cappedCents} />
                </div>
                <dl className="mt-6 grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-border bg-border text-sm sm:grid-cols-4">
                  <BreakdownItem label="Cancel saves" value={formatCents(running.cancelFeesCents)} />
                  <BreakdownItem label="Failed payments" value={formatCents(running.dunningFeesCents)} />
                  <BreakdownItem label="Credits" value={running.creditAppliedCents ? `−${formatCents(running.creditAppliedCents)}` : "—"} />
                  <BreakdownItem
                    label="On hold (disputes)"
                    value={running.heldCents ? formatCents(running.heldCents) : "—"}
                    tone={running.heldCents ? "warning" : undefined}
                  />
                </dl>
              </CardContent>
            </Card>

            <Card className="flex flex-col">
              <CardHeader>
                <div>
                  <CardTitle>Billing card</CardTitle>
                  <CardDescription>Charged automatically for unquit&apos;s fees</CardDescription>
                </div>
                {hasCard ? (
                  onHold ? <Badge tone="warning" dot>On hold</Badge> : <Badge tone="success" dot>Active</Badge>
                ) : (
                  <Badge tone="warning" dot>Not set</Badge>
                )}
              </CardHeader>
              <CardContent className="flex flex-1 flex-col">
                <div className="flex items-center gap-3">
                  <span aria-hidden="true" className="flex h-10 w-14 shrink-0 items-center justify-center rounded-lg border border-border bg-muted text-muted-foreground shadow-xs">
                    <CreditCard className="h-5 w-5" />
                  </span>
                  {hasCard ? (
                    <p className="text-lg font-semibold text-foreground">
                      <span className="capitalize">{(billing.billing_pm_brand ?? "Card").toLowerCase()}</span>
                      {billing.billing_pm_last4 ? ` •••• ${billing.billing_pm_last4}` : " on file"}
                    </p>
                  ) : (
                    <p className="text-lg font-semibold text-foreground">No card yet</p>
                  )}
                </div>
                <dl className="mt-4 space-y-1.5 text-xs text-muted-foreground">
                  <div className="flex justify-between gap-3">
                    <dt>Next charge</dt>
                    <dd className="font-medium tabular-nums text-foreground">
                      {estimateCents === 0
                        ? "Nothing due so far"
                        : estimateCents < MIN_CHARGE_CENTS
                          ? `${formatCents(estimateCents)}, carried forward (under ${formatCents(MIN_CHARGE_CENTS)})`
                          : `About ${formatCents(estimateCents)} on ${nextChargeDate(running.month)}`}
                    </dd>
                  </div>
                  {billing.dodo_mandate_at && hasCard ? (
                    <div className="flex justify-between gap-3">
                      <dt>Card saved</dt>
                      <dd>{dateLabel(billing.billing_pm_updated_at ?? billing.dodo_mandate_at)}</dd>
                    </div>
                  ) : null}
                </dl>
                <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
                  {hasCard
                    ? "No charge happens until you have fees. The charge appears on your card statement from Dodo Payments, unquit's merchant of record."
                    : "Save a card once. Nothing is charged now, and nothing ever is until unquit has saved you revenue."}
                </p>
                <div className="mt-auto pt-5">
                  <form action="/api/billing/setup" method="post">
                    <Button type="submit" variant={hasCard ? "secondary" : "brand"} className="w-full sm:w-auto">
                      {hasCard ? "Update card" : "Add a billing card"}
                    </Button>
                  </form>
                  <p className="mt-2 flex items-center gap-1.5 text-xs text-muted-foreground">
                    <Lock className="h-3 w-3 shrink-0" aria-hidden="true" /> Secure checkout by Dodo Payments. unquit never sees your card number.
                  </p>
                </div>
              </CardContent>
            </Card>
          </section>

          <section aria-label="Billing totals" className="grid gap-4 sm:grid-cols-3">
            <StatCard label="Statements" icon={<FileText />} display={String(periods.length)} hint="One per month since you connected" />
            <StatCard
              label="Paid to date"
              icon={<Receipt />}
              display={formatCents(paidToDate)}
              hint="Card charges, after the cap, credits and refunds"
            />
            <StatCard
              label="Saved by the cap"
              icon={<CircleGauge />}
              display={formatCents(periods.reduce((a, p) => a + Number(p.cap_discount_cents), 0))}
              hint={`Fees above ${formatCents(MONTHLY_FEE_CAP_CENTS)}/month you never paid`}
              emphasis
            />
          </section>

          <Card className="overflow-hidden">
            <CardHeader>
              <div>
                <CardTitle>Past statements</CardTitle>
                <CardDescription>Every month&apos;s fee lines, the cap, credits, and the card charge with its receipt</CardDescription>
              </div>
            </CardHeader>
            {periods.length === 0 ? (
              <EmptyState compact art="receipts" title="No statements yet" description="Your first statement arrives on the 1st of next month." />
            ) : (
              <div className="overflow-x-auto">
                <table className="min-w-full border-separate border-spacing-0 text-left text-sm">
                  <caption className="sr-only">Past statements</caption>
                  <thead>
                    <tr>
                      <Th>Month</Th>
                      <Th align="right">Fees</Th>
                      <Th align="right">Cap / credits</Th>
                      <Th align="right">Charged</Th>
                      <Th>Payment</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {periods.map((p) => {
                      const charge = chargeByPeriod.get(p.id);
                      const st =
                        p.status === "zero"
                          ? { label: "Nothing to pay", tone: "neutral" as const }
                          : charge
                            ? CHARGE_STATUS[charge.status]
                            : p.payment_status === "carried_forward"
                              ? CHARGE_STATUS.carried_forward
                              : p.status === "invoiced"
                                ? LEGACY_INVOICE_STATUS[p.invoice_status ?? ""] ?? { label: "Invoiced", tone: "neutral" as const }
                                : { label: p.status === "failed" ? "Retrying" : "Preparing", tone: p.status === "failed" ? ("warning" as const) : ("neutral" as const) };
                      const off = Number(p.cap_discount_cents) + Number(p.credit_applied_cents);
                      const receipt = charge?.receipt_url ?? p.hosted_invoice_url;
                      const detail =
                        charge?.status === "paid" && charge.paid_at
                          ? `Paid ${dateLabel(charge.paid_at)}`
                          : charge?.status === "retrying" && charge.next_attempt_at
                            ? `Next try ${dateLabel(charge.next_attempt_at)}`
                            : p.payment_status === "carried_forward"
                              ? "Added to the next charge"
                              : null;
                      return (
                        <tr key={p.id} className="group transition-colors hover:bg-muted/50">
                          <Td>
                            <Link
                              href={`/dashboard/billing/${monthSlug(p.period_month)}`}
                              className="whitespace-nowrap rounded font-medium text-brand-text underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                            >
                              {monthLabel(p.period_month)}
                            </Link>
                          </Td>
                          <Td align="right" className="tabular-nums">{formatCents(Number(p.gross_cents))}</Td>
                          <Td align="right" className="tabular-nums text-muted-foreground">{off > 0 ? `−${formatCents(off)}` : "—"}</Td>
                          <Td align="right" className="font-medium tabular-nums">
                            {formatCents(charge ? Number(charge.amount_cents) : p.payment_status === "carried_forward" ? 0 : Number(p.total_cents))}
                          </Td>
                          <Td>
                            <span className="inline-flex flex-wrap items-center gap-x-3 gap-y-1">
                              <Badge tone={st.tone} dot>{st.label}</Badge>
                              {detail ? <span className="whitespace-nowrap text-xs text-muted-foreground">{detail}</span> : null}
                              {receipt ? (
                                <a
                                  href={receipt}
                                  target="_blank"
                                  rel="noreferrer"
                                  className="whitespace-nowrap rounded text-xs font-medium text-brand-text underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                                >
                                  {charge?.receipt_url ? "Receipt" : "View invoice"} ↗<span className="sr-only"> (opens in a new tab)</span>
                                </a>
                              ) : null}
                            </span>
                          </Td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </div>
      )}
    </DashboardShell>
  );
}

function BreakdownItem({ label, value, tone }: { label: string; value: string; tone?: "warning" }) {
  return (
    <div className="bg-card px-4 py-3">
      <dt className="text-2xs font-medium uppercase tracking-wider text-muted-foreground">{label}</dt>
      <dd className={cn("mt-1 font-medium tabular-nums", tone === "warning" ? "text-warning" : "text-foreground")}>{value}</dd>
    </div>
  );
}

function Th({ children, align = "left" }: { children: React.ReactNode; align?: "left" | "right" }) {
  return (
    <th
      scope="col"
      className={cn(
        "whitespace-nowrap border-b border-border bg-card px-5 py-2.5 text-2xs font-medium uppercase tracking-wider text-muted-foreground",
        align === "right" && "text-right",
      )}
    >
      {children}
    </th>
  );
}

function Td({ children, align = "left", className }: { children: React.ReactNode; align?: "left" | "right"; className?: string }) {
  return (
    <td className={cn("border-b border-border/70 px-5 py-3 align-middle text-foreground group-last:border-b-0", align === "right" && "text-right", className)}>
      {children}
    </td>
  );
}
