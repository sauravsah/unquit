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
import { finishSetupSession, syncPlatformInvoice } from "@/lib/billing/platform";
import { serverEnv } from "@/lib/env";
import { loadRunningTotal } from "@/lib/ledger/dashboard";
import { monthLabel, monthSlug } from "@/lib/ledger/fees";
import { formatCents, MONTHLY_FEE_CAP_CENTS } from "@/lib/pricing";
import { getStripe } from "@/lib/stripe/client";
import { getSessionUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db";

export const dynamic = "force-dynamic";

const SETUP_BANNERS: Record<string, { tone: "good" | "bad" | "neutral"; text: string }> = {
  success: { tone: "good", text: "Card saved. unquit's monthly invoice will be charged to it automatically." },
  pending: { tone: "neutral", text: "Stripe is still confirming your card. Refresh in a moment." },
  cancelled: { tone: "neutral", text: "No card added. You can add one any time." },
  error: { tone: "bad", text: "We couldn't open Stripe Checkout. Please try again." },
};

const INVOICE_STATUS: Record<string, { label: string; tone: "success" | "warning" | "neutral" | "danger" }> = {
  paid: { label: "Paid", tone: "success" },
  open: { label: "Due", tone: "warning" },
  draft: { label: "Preparing", tone: "neutral" },
  void: { label: "Void", tone: "neutral" },
  uncollectible: { label: "Unpaid", tone: "danger" },
};

export default async function BillingPage({ searchParams }: { searchParams: { setup?: string; session_id?: string } }) {
  const db = getDb();
  const user = await getSessionUser();
  if (!user) redirect("/login?next=/dashboard/billing");

  const account = await getOrCreateAccount(db, user);
  const connected = account.stripe_connection_status === "connected" && !!account.stripe_account_id;

  // Back from Stripe Checkout (setup mode): make the card the invoice default.
  let setupState = searchParams.setup;
  if (setupState === "success" && searchParams.session_id) {
    try {
      const ok = await finishSetupSession(db, getStripe(), account.id, searchParams.session_id);
      if (!ok) setupState = "pending";
    } catch (error) {
      console.error("[billing] finishing Checkout failed", error);
      setupState = "error";
    }
  }

  let { account: billing, periods } = await loadBillingPage(db, account.id);

  // Without the optional platform webhook, refresh unpaid invoices' status from Stripe.
  if (!serverEnv.stripePlatformWebhookSecret()) {
    const open = periods.filter((p) => p.stripe_invoice_id && p.invoice_status !== "paid" && p.invoice_status !== "void").slice(0, 3);
    if (open.length > 0) {
      try {
        for (const p of open) await syncPlatformInvoice(db, await getStripe().invoices.retrieve(p.stripe_invoice_id!));
        ({ account: billing, periods } = await loadBillingPage(db, account.id));
      } catch (error) {
        console.warn("[billing] refreshing invoice status failed", error);
      }
    }
  }

  const running = await loadRunningTotal(db, account.id);
  const banner = setupState ? SETUP_BANNERS[setupState] : undefined;
  const hasCard = billing.billing_pm_status === "active";

  return (
    <DashboardShell email={user.email} active="/dashboard/billing" showTabs={connected}>
      {!connected && periods.length === 0 ? (
        <ConnectFirst />
      ) : (
        <div className="space-y-6">
          {banner ? <Notice tone={banner.tone}>{banner.text}</Notice> : null}

          <PageHeader
            title="Billing"
            className="mb-2"
            badge={<Badge tone="success" dot>Pay per save</Badge>}
            description={
              <>
                No base fee. You pay 20% of saved MRR for a saved customer&apos;s first 3 paid months, and 10% of failed payments unquit recovers.
                Never more than {formatCents(MONTHLY_FEE_CAP_CENTS)} in a month. One invoice on the 1st for the month before.
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
                  <CardTitle>Payment method</CardTitle>
                  <CardDescription>Used for unquit&apos;s monthly invoice</CardDescription>
                </div>
                {hasCard ? <Badge tone="success" dot>Active</Badge> : <Badge tone="warning" dot>Not set</Badge>}
              </CardHeader>
              <CardContent className="flex flex-1 flex-col">
                <div className="flex items-center gap-3">
                  <span aria-hidden="true" className="flex h-10 w-14 shrink-0 items-center justify-center rounded-lg border border-border bg-muted text-muted-foreground shadow-xs">
                    <CreditCard className="h-5 w-5" />
                  </span>
                  {hasCard ? (
                    <p className="text-lg font-semibold text-foreground">
                      <span className="capitalize">{billing.billing_pm_brand ?? "Card"}</span> •••• {billing.billing_pm_last4 ?? "····"}
                    </p>
                  ) : (
                    <p className="text-lg font-semibold text-foreground">No card yet</p>
                  )}
                </div>
                <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
                  {hasCard
                    ? "Charged automatically when each monthly invoice is ready."
                    : "Without a card, Stripe emails each invoice with a link to pay within 14 days."}
                </p>
                <div className="mt-auto pt-5">
                  <form action="/api/billing/setup" method="post">
                    <Button type="submit" variant={hasCard ? "secondary" : "brand"} className="w-full sm:w-auto">
                      {hasCard ? "Replace card" : "Add a card"}
                    </Button>
                  </form>
                  <p className="mt-2 flex items-center gap-1.5 text-xs text-muted-foreground">
                    <Lock className="h-3 w-3 shrink-0" aria-hidden="true" /> Secure Stripe Checkout. Nothing is charged now.
                  </p>
                </div>
              </CardContent>
            </Card>
          </section>

          <section aria-label="Billing totals" className="grid gap-4 sm:grid-cols-3">
            <StatCard label="Statements" icon={<FileText />} display={String(periods.length)} hint="One per month since you connected" />
            <StatCard
              label="Billed to date"
              icon={<Receipt />}
              display={formatCents(periods.reduce((a, p) => a + Number(p.total_cents), 0))}
              hint="After the cap and credits"
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
                <CardDescription>Every month&apos;s fee lines, the cap, credits and the Stripe invoice</CardDescription>
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
                      <Th align="right">Total</Th>
                      <Th>Invoice</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {periods.map((p) => {
                      const st =
                        p.status === "zero"
                          ? { label: "Nothing to pay", tone: "neutral" as const }
                          : INVOICE_STATUS[p.invoice_status ?? ""] ?? { label: p.status === "failed" ? "Retrying" : "Preparing", tone: p.status === "failed" ? ("warning" as const) : ("neutral" as const) };
                      const off = Number(p.cap_discount_cents) + Number(p.credit_applied_cents);
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
                          <Td align="right" className="font-medium tabular-nums">{formatCents(Number(p.total_cents))}</Td>
                          <Td>
                            <span className="inline-flex flex-wrap items-center gap-x-3 gap-y-1">
                              <Badge tone={st.tone} dot>{st.label}</Badge>
                              {p.hosted_invoice_url ? (
                                <a
                                  href={p.hosted_invoice_url}
                                  target="_blank"
                                  rel="noreferrer"
                                  className="whitespace-nowrap rounded text-xs font-medium text-brand-text underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                                >
                                  View invoice ↗<span className="sr-only"> (opens in a new tab)</span>
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
