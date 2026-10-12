import { ArrowRight, BadgeDollarSign, CircleGauge, Lock, Percent, Plug, RotateCcw, ShieldCheck } from "lucide-react";
import Link from "next/link";
import { redirect } from "next/navigation";
import { DashboardShell, PageHeader } from "@/components/DashboardShell";
import { CancelSessionsTable } from "@/components/dashboard/CancelSessionsTable";
import { LazyReasonsDonut, LazySavedMrrChart } from "@/components/dashboard/LazyCharts";
import { LedgerFilterForm } from "@/components/dashboard/LedgerFilterForm";
import { LedgerTable } from "@/components/dashboard/LedgerTable";
import { LiveActivity } from "@/components/dashboard/LiveActivity";
import { OnboardingChecklist, type ChecklistStep } from "@/components/dashboard/OnboardingChecklist";
import { WidgetKeysCard } from "@/components/dashboard/WidgetKeysCard";
import { Stagger, StaggerItem } from "@/components/motion";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/components/ui/cn";
import { EmptyState } from "@/components/ui/empty-state";
import { ProgressRing } from "@/components/ui/progress-ring";
import { StatCard } from "@/components/ui/stat-card";
import { getOrCreateAccount, getWidgetKeys, type Account } from "@/lib/accounts";
import { loadDashboardData } from "@/lib/dashboard";
import { parseLedgerFilters, type LedgerFilters } from "@/lib/ledger/dashboard";
import { MONTHLY_FEE_CAP_CENTS, formatCents } from "@/lib/pricing";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { loadOverviewExtras, relativeDelta } from "./_lib/overview";

export const dynamic = "force-dynamic";

const BANNERS: Record<string, { tone: "good" | "bad" | "neutral"; text: string }> = {
  connected: { tone: "good", text: "Stripe connected. New subscription and invoice events will appear here." },
  disconnected: { tone: "neutral", text: "Stripe disconnected. Unquit no longer has access to your account." },
  denied: { tone: "neutral", text: "You cancelled the Stripe connection. Connect any time." },
  invalid_state: { tone: "bad", text: "That Stripe link expired or didn't match this browser. Please try connecting again." },
  exchange_failed: { tone: "bad", text: "Stripe didn't accept the connection. Please try again." },
  save_failed: { tone: "bad", text: "We couldn't save your Stripe connection. Please try again." },
  already_connected_elsewhere: {
    tone: "bad",
    text: "That Stripe account is already connected to another Unquit login.",
  },
  secret_rotated: {
    tone: "good",
    text: "New signing secret created. Update it on your server now: signatures made with the old one stop working.",
  },
  rotate_failed: { tone: "bad", text: "We couldn't rotate the signing secret. Please try again." },
};

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: { stripe?: string; widget?: string; type?: string; status?: string; month?: string };
}) {
  const supabase = createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login?next=/dashboard");

  const account = await getOrCreateAccount(supabase, user);
  const bannerKey = searchParams.stripe ?? searchParams.widget;
  const banner = bannerKey ? BANNERS[bannerKey] : undefined;
  const connected = account.stripe_connection_status === "connected" && !!account.stripe_account_id;

  return (
    <DashboardShell email={user.email} active="/dashboard" showTabs={connected}>
      {banner ? <Banner tone={banner.tone} text={banner.text} /> : null}
      {connected ? <ConnectedView account={account} filters={parseLedgerFilters(searchParams)} /> : <ConnectStripe account={account} />}
    </DashboardShell>
  );
}

function Banner({ tone, text }: { tone: "good" | "bad" | "neutral"; text: string }) {
  const styles = {
    good: "border-brand/30 bg-brand-soft text-foreground",
    bad: "border-danger/30 bg-danger-soft text-danger",
    neutral: "border-border bg-card text-muted-foreground",
  }[tone];
  return (
    <p role="status" className={cn("mb-6 flex items-center gap-2.5 rounded-xl border px-4 py-3 text-sm shadow-xs animate-slide-up", styles)}>
      <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", tone === "good" ? "bg-brand" : tone === "bad" ? "bg-danger" : "bg-muted-foreground")} />
      {text}
    </p>
  );
}

function ConnectStripe({ account }: { account: Account }) {
  const wasRevoked = account.stripe_connection_status === "revoked";
  const steps: ChecklistStep[] = [
    { id: "stripe", title: "Connect Stripe", description: "One click with Stripe Connect. Read access to subscriptions and invoices.", done: false, href: "/api/stripe/connect", cta: "Connect", external: true },
    { id: "flow", title: "Pick your cancel offers", description: "Start from a template: discount, pause or downgrade.", done: false, href: "/dashboard/flows", cta: "Open" },
    { id: "widget", title: "Add the widget to your app", description: "One script tag and a signed customer id.", done: false, href: "/dashboard/test", cta: "Open" },
    { id: "dunning", title: "Switch on failed-payment emails", description: "Three emails matched to why the card failed.", done: false, href: "/dashboard/dunning", cta: "Open" },
  ];
  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)]">
      <section className="relative overflow-hidden rounded-2xl border border-border bg-card p-8 shadow-card sm:p-10">
        <div aria-hidden="true" className="bg-grid mask-radial absolute inset-0" />
        <div aria-hidden="true" className="absolute -left-10 -top-20 h-56 w-80 rounded-full bg-brand/20 blur-3xl" />
        <div className="relative">
          <span className="flex h-12 w-12 items-center justify-center rounded-xl border border-border bg-background shadow-lift">
            <Plug className="h-5 w-5 text-brand-text" />
          </span>
          <h1 className="mt-6 text-3xl font-semibold tracking-tight text-foreground">
            {wasRevoked ? "Reconnect your Stripe account" : "Connect your Stripe account"}
          </h1>
          <p className="mt-3 max-w-md text-sm leading-relaxed text-muted-foreground">
            {wasRevoked
              ? "Access was removed from inside Stripe. Reconnect to keep saving customers."
              : "Unquit reads your subscriptions and invoices to spot customers at risk. We never move money without a save rule being met, and you can disconnect any time."}
          </p>
          <div className="mt-8 flex flex-wrap items-center gap-3">
            {/* A plain link (not next/link): this route redirects off-site to Stripe. */}
            <Button asChild variant="brand" size="lg">
              {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
              <a href="/api/stripe/connect">
                Connect Stripe <ArrowRight className="h-4 w-4" />
              </a>
            </Button>
            <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Lock className="h-3.5 w-3.5" /> You&apos;ll approve access on Stripe, then come back here.
            </span>
          </div>
          <ul className="mt-10 grid gap-3 text-sm sm:grid-cols-3">
            {[
              { icon: BadgeDollarSign, text: "$0 until we save revenue" },
              { icon: ShieldCheck, text: "Every save verified in Stripe" },
              { icon: CircleGauge, text: "Capped at $299 a month" },
            ].map(({ icon: Icon, text }) => (
              <li key={text} className="flex items-center gap-2 text-muted-foreground">
                <Icon className="h-4 w-4 shrink-0 text-brand-text" /> {text}
              </li>
            ))}
          </ul>
        </div>
      </section>
      <OnboardingChecklist steps={steps} />
    </div>
  );
}

async function ConnectedView({ account, filters }: { account: Account; filters: LedgerFilters }) {
  const supabase = createSupabaseServerClient();
  const filtered = !!(filters.type || filters.status || filters.month);
  const [data, keys, extras] = await Promise.all([
    loadDashboardData(supabase, account.id, filters),
    getWidgetKeys(supabase, account.id),
    loadOverviewExtras(supabase, account.id),
  ]);

  const capShare = data.fees.cappedCents / MONTHLY_FEE_CAP_CENTS;
  const saveRateDelta =
    data.saveRate !== null && extras.saveRateLastMonth !== null ? data.saveRate - extras.saveRateLastMonth : null;
  const steps: ChecklistStep[] = [
    { id: "stripe", title: "Connect Stripe", description: "Connected. Subscription and invoice events flow in.", done: true, href: "/dashboard", cta: "" },
    { id: "flow", title: "Pick your cancel offers", description: "Start from a template: discount, pause or downgrade.", done: extras.checklist.flowSaved, href: "/dashboard/flows", cta: "Edit flow" },
    { id: "widget", title: "Add the widget to your app", description: "Open it once (try it on a test customer) to tick this off.", done: extras.checklist.widgetUsed, href: "/dashboard/test", cta: "Test it" },
    { id: "dunning", title: "Switch on failed-payment emails", description: "Three emails matched to why the card failed.", done: extras.checklist.dunningOn, href: "/dashboard/dunning", cta: "Set up" },
  ];
  const setupDone = steps.every((s) => s.done);
  const hasTrend = extras.trend.some((p) => p.saved > 0 || p.recovered > 0);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Overview"
        badge={account.stripe_livemode === false ? <Badge tone="warning" dot>Test mode</Badge> : <Badge tone="success" dot="pulse">Live</Badge>}
        description={
          <>
            Stripe account <code className="rounded-md border border-border bg-muted px-1.5 py-0.5 font-mono text-xs text-foreground">{account.stripe_account_id}</code>
          </>
        }
        actions={
          <>
            <form action="/api/stripe/disconnect" method="post">
              <Button variant="ghost" size="sm" type="submit">
                Disconnect Stripe
              </Button>
            </form>
            <Button asChild variant="secondary" size="sm">
              <Link href="/dashboard/flows">Edit cancel flow</Link>
            </Button>
          </>
        }
        className="mb-2"
      />

      <Stagger className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StaggerItem>
          <StatCard
            label="Saved MRR · this month"
            icon={<BadgeDollarSign />}
            value={data.savedMrrCents}
            format="cents"
            delta={relativeDelta(data.savedMrrCents, extras.savedMrrLastMonthCents)}
            hint={`${data.savedCount} verified cancel save${data.savedCount === 1 ? "" : "s"}`}
            emphasis
          />
        </StaggerItem>
        <StaggerItem>
          <StatCard
            label="Save rate"
            icon={<Percent />}
            value={data.saveRate}
            format="percent"
            delta={saveRateDelta}
            deltaLabel="points vs last month"
            hint={
              data.saveRate === null
                ? "No finished cancel attempts this month yet"
                : `Verified ÷ ${data.finishedSessions} finished attempt${data.finishedSessions === 1 ? "" : "s"}`
            }
          />
        </StaggerItem>
        <StaggerItem>
          <StatCard
            label="Recovered · this month"
            icon={<RotateCcw />}
            value={data.recoveredCents}
            format="cents"
            delta={relativeDelta(data.recoveredCents, extras.recoveredLastMonthCents)}
            hint={`${data.recoveredCount} by unquit · ${formatCents(data.mrrAtRiskCents)} at risk`}
          />
        </StaggerItem>
        <StaggerItem>
          <StatCard
            label="Fees this month"
            icon={<CircleGauge />}
            value={data.fees.totalCents}
            format="cents"
            hint={
              <Link href="/dashboard/billing" className="hover:text-foreground">
                {data.fees.capReached ? "Cap reached: the rest is free" : `of the ${formatCents(MONTHLY_FEE_CAP_CENTS)} cap`} · Billing →
              </Link>
            }
            aside={<ProgressRing value={capShare} label="Fees used of the monthly cap" />}
          />
        </StaggerItem>
      </Stagger>

      {setupDone ? null : <OnboardingChecklist steps={steps} />}

      <div className="grid gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader className="border-b-0 pb-0">
            <div>
              <CardTitle>Saved MRR over time</CardTitle>
              <CardDescription>Weekly, last 12 weeks · verified saves and payments recovered by unquit</CardDescription>
            </div>
            <div className="flex items-center gap-3 text-2xs text-muted-foreground">
              <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-brand" /> Saved MRR</span>
              <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-zinc-500" /> Recovered</span>
            </div>
          </CardHeader>
          <div className="p-3 pt-4 sm:p-5">
            {hasTrend ? (
              <LazySavedMrrChart data={extras.trend} />
            ) : (
              <EmptyState compact art="chart" title="Your chart starts with the first save" description="Verified saves and recovered payments plot here week by week." className="h-[260px]" />
            )}
          </div>
        </Card>
        <Card>
          <CardHeader className="border-b-0 pb-0">
            <div>
              <CardTitle>Why customers leave</CardTitle>
              <CardDescription>Cancel reasons, last 90 days</CardDescription>
            </div>
          </CardHeader>
          <div className="p-5">
            {extras.reasons.length ? (
              <LazyReasonsDonut data={extras.reasons} />
            ) : (
              <EmptyState compact art="flow" title="No reasons yet" description="The exit survey answers show up here." />
            )}
          </div>
        </Card>
      </div>

      <Card className="scroll-mt-20 overflow-hidden" id="ledger">
        <CardHeader>
          <div>
            <CardTitle>Saves ledger</CardTitle>
            <CardDescription>Every save has a receipt you can dispute</CardDescription>
          </div>
          <LedgerFilterForm filters={filters} />
        </CardHeader>
        <LedgerTable rows={data.ledger} filtered={filtered} />
      </Card>

      <div className="grid gap-6 lg:grid-cols-3">
        <Card className="overflow-hidden">
          <LiveActivity accountId={account.id} initial={extras.activity} />
        </Card>
        <Card className="overflow-hidden lg:col-span-2">
          <CardHeader>
            <div>
              <CardTitle>Cancel sessions</CardTitle>
              <CardDescription>The 25 most recent times a customer opened your cancel flow</CardDescription>
            </div>
            <Link href="/dashboard/flows" className="text-xs font-medium text-brand-text hover:underline">
              Edit cancel flow →
            </Link>
          </CardHeader>
          <CancelSessionsTable rows={data.cancelSessions} />
        </Card>
      </div>

      <WidgetKeysCard publishableKey={keys.widget_publishable_key} signingSecret={keys.widget_signing_secret} />
    </div>
  );
}
