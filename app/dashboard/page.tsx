import Link from "next/link";
import { redirect } from "next/navigation";
import { DashboardShell } from "@/components/DashboardShell";
import { StatCard } from "@/components/StatCard";
import { getOrCreateAccount, getWidgetKeys, type Account } from "@/lib/accounts";
import { loadDashboardData, type CancelSessionRow, type LedgerRow } from "@/lib/dashboard";
import { describeOfferRecord } from "@/lib/flows/describe";
import { MONTHLY_FEE_CAP_CENTS, formatCents } from "@/lib/pricing";
import { createSupabaseServerClient } from "@/lib/supabase/server";

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

export default async function DashboardPage({ searchParams }: { searchParams: { stripe?: string; widget?: string } }) {
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
      {connected ? <ConnectedView account={account} /> : <ConnectStripe account={account} />}
    </DashboardShell>
  );
}

function Banner({ tone, text }: { tone: "good" | "bad" | "neutral"; text: string }) {
  const styles = {
    good: "border-brand/30 bg-brand-light text-ink",
    bad: "border-red-200 bg-red-50 text-red-800",
    neutral: "border-neutral-200 bg-white text-neutral-700",
  }[tone];
  return (
    <p role="status" className={`mb-8 rounded-lg border px-4 py-3 text-sm ${styles}`}>
      {text}
    </p>
  );
}

function ConnectStripe({ account }: { account: Account }) {
  const wasRevoked = account.stripe_connection_status === "revoked";
  return (
    <section className="mx-auto max-w-xl rounded-2xl border border-neutral-200 bg-white p-10 text-center">
      <h1 className="text-2xl font-semibold tracking-tight text-ink">Connect your Stripe account</h1>
      <p className="mt-3 text-sm leading-relaxed text-neutral-600">
        {wasRevoked
          ? "Access was removed from inside Stripe. Reconnect to keep saving customers."
          : "Unquit reads your subscriptions and invoices to spot customers at risk. We never move money without a save rule being met, and you can disconnect any time."}
      </p>
      {/* A plain link (not next/link): this route redirects off-site to Stripe. */}
      {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
      <a
        href="/api/stripe/connect"
        className="mt-8 inline-flex items-center rounded-lg bg-brand px-5 py-3 text-sm font-semibold text-white hover:bg-brand-dark"
      >
        Connect Stripe
      </a>
      <p className="mt-4 text-xs text-neutral-500">You&apos;ll be sent to Stripe to approve access, then brought back here.</p>
    </section>
  );
}

async function ConnectedView({ account }: { account: Account }) {
  const supabase = createSupabaseServerClient();
  const [data, keys] = await Promise.all([loadDashboardData(supabase, account.id), getWidgetKeys(supabase, account.id)]);

  return (
    <div className="space-y-8">
      <section className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-ink">Overview</h1>
          <p className="mt-1 text-sm text-neutral-500">
            Stripe account <code className="rounded bg-neutral-100 px-1.5 py-0.5 text-ink">{account.stripe_account_id}</code>
            {account.stripe_livemode === false ? (
              <span className="ml-2 rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800">Test mode</span>
            ) : null}
          </p>
        </div>
        <form action="/api/stripe/disconnect" method="post">
          <button className="rounded-lg border border-neutral-300 bg-white px-3 py-2 text-sm font-medium text-neutral-700 hover:border-neutral-400 hover:text-ink">
            Disconnect Stripe
          </button>
        </form>
      </section>

      <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label="MRR at risk"
          value={formatCents(data.mrrAtRiskCents)}
          hint={`${data.pastDueCount} past-due subscription${data.pastDueCount === 1 ? "" : "s"}`}
        />
        <StatCard label="Saved MRR (this month)" value={formatCents(data.savedMrrCents)} hint="Verified cancel saves" emphasis />
        <StatCard
          label="Save rate"
          value={data.saveRate === null ? "—" : `${Math.round(data.saveRate * 100)}%`}
          hint={data.saveRate === null ? "No cancel attempts this month yet" : "Verified saves ÷ cancel attempts"}
        />
        <StatCard
          label="Fees this month"
          value={formatCents(data.bill.totalCents)}
          hint={`Capped at ${formatCents(MONTHLY_FEE_CAP_CENTS)}${data.bill.capReached ? " — cap reached" : ""}`}
        />
      </section>

      <section className="rounded-xl border border-neutral-200 bg-white">
        <div className="flex items-center justify-between border-b border-neutral-200 px-5 py-4">
          <h2 className="text-base font-semibold text-ink">Saves ledger</h2>
          <span className="text-xs text-neutral-500">Every save gets a receipt you can dispute</span>
        </div>
        <LedgerTable rows={data.ledger} />
      </section>

      <section className="rounded-xl border border-neutral-200 bg-white">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-neutral-200 px-5 py-4">
          <h2 className="text-base font-semibold text-ink">Cancel sessions</h2>
          <Link href="/dashboard/flows" className="text-xs font-medium text-brand hover:text-brand-dark">
            Edit cancel flow →
          </Link>
        </div>
        <CancelSessionsTable rows={data.cancelSessions} />
      </section>

      <WidgetKeysCard publishableKey={keys.widget_publishable_key} signingSecret={keys.widget_signing_secret} />
    </div>
  );
}

function WidgetKeysCard({ publishableKey, signingSecret }: { publishableKey: string; signingSecret: string }) {
  return (
    <section className="rounded-xl border border-neutral-200 bg-white p-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="text-base font-semibold text-ink">Widget keys</h2>
          <p className="mt-1 text-sm text-neutral-500">
            Put the publishable key in the script tag. Keep the signing secret on your server: it signs each customer so nobody
            can open the cancel flow for someone else.{" "}
            <Link href="/dashboard/test" className="font-medium text-brand hover:text-brand-dark">
              Test the widget →
            </Link>
          </p>
        </div>
      </div>
      <dl className="mt-4 grid gap-4 text-sm md:grid-cols-2">
        <div>
          <dt className="text-xs font-medium uppercase tracking-wide text-neutral-500">Publishable key (public)</dt>
          <dd className="mt-1 break-all rounded-lg bg-neutral-100 px-3 py-2 font-mono text-xs text-ink">{publishableKey}</dd>
        </div>
        <div>
          <dt className="text-xs font-medium uppercase tracking-wide text-neutral-500">Signing secret (server only)</dt>
          <dd className="mt-1">
            <details className="group rounded-lg bg-neutral-100 px-3 py-2">
              <summary className="cursor-pointer select-none text-xs font-medium text-neutral-700">Reveal secret</summary>
              <code className="mt-2 block break-all font-mono text-xs text-ink">{signingSecret}</code>
            </details>
            <form action="/api/dashboard/rotate-secret" method="post" className="mt-2">
              <button className="text-xs font-medium text-neutral-600 underline underline-offset-2 hover:text-ink">
                Rotate secret
              </button>
            </form>
          </dd>
        </div>
      </dl>
    </section>
  );
}

const OUTCOME: Record<CancelSessionRow["status"], { label: string; style: string }> = {
  started: { label: "In progress", style: "bg-neutral-100 text-neutral-600" },
  offer_shown: { label: "Offer shown", style: "bg-neutral-100 text-neutral-600" },
  offer_accepted: { label: "Saved", style: "bg-brand-light text-brand-dark" },
  canceled: { label: "Cancelled", style: "bg-neutral-100 text-neutral-700" },
  abandoned: { label: "Closed", style: "bg-neutral-100 text-neutral-500" },
};

function CancelSessionsTable({ rows }: { rows: CancelSessionRow[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="min-w-full text-left text-sm">
        <thead className="text-xs uppercase tracking-wide text-neutral-500">
          <tr>
            <th className="px-5 py-3 font-medium">Date</th>
            <th className="px-5 py-3 font-medium">Customer</th>
            <th className="px-5 py-3 font-medium">Reason</th>
            <th className="px-5 py-3 font-medium">Offer</th>
            <th className="px-5 py-3 font-medium">Outcome</th>
            <th className="px-5 py-3 font-medium">MRR</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-neutral-100">
          {rows.length === 0 ? (
            <tr>
              <td colSpan={6} className="px-5 py-12 text-center text-sm text-neutral-500">
                No cancel attempts yet. Each time a customer opens your cancel flow, it shows up here.
              </td>
            </tr>
          ) : (
            rows.map((row) => {
              const outcome = OUTCOME[row.status];
              const offer = row.offers_enabled ? describeOfferRecord(row.offer_shown) : "Skipped (offer limit)";
              return (
                <tr key={row.id}>
                  <td className="whitespace-nowrap px-5 py-3 text-neutral-500">{new Date(row.started_at).toLocaleDateString("en-US")}</td>
                  <td className="px-5 py-3 font-mono text-xs text-neutral-600">{row.stripe_customer_id}</td>
                  <td className="px-5 py-3 text-neutral-700">
                    {row.reason_label ?? row.reason ?? "—"}
                    {row.reason_detail ? (
                      <span className="mt-0.5 block max-w-xs truncate text-xs text-neutral-500" title={row.reason_detail}>
                        “{row.reason_detail}”
                      </span>
                    ) : null}
                  </td>
                  <td className="px-5 py-3 text-neutral-700">{offer}</td>
                  <td className="px-5 py-3">
                    <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${outcome.style}`}>{outcome.label}</span>
                  </td>
                  <td className="px-5 py-3 tabular-nums text-ink">
                    {row.mrr_at_start_cents === null ? "—" : `${formatCents(Number(row.mrr_at_start_cents))}/mo`}
                  </td>
                </tr>
              );
            })
          )}
        </tbody>
      </table>
    </div>
  );
}

const STATUS_STYLES: Record<LedgerRow["status"], string> = {
  pending: "bg-neutral-100 text-neutral-700",
  verified: "bg-brand-light text-brand-dark",
  disputed: "bg-amber-100 text-amber-800",
  clawed_back: "bg-neutral-100 text-neutral-500 line-through",
};

function LedgerTable({ rows }: { rows: LedgerRow[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="min-w-full text-left text-sm">
        <thead className="text-xs uppercase tracking-wide text-neutral-500">
          <tr>
            <th className="px-5 py-3 font-medium">Receipt</th>
            <th className="px-5 py-3 font-medium">Type</th>
            <th className="px-5 py-3 font-medium">Customer</th>
            <th className="px-5 py-3 font-medium">Offer</th>
            <th className="px-5 py-3 font-medium">Saved</th>
            <th className="px-5 py-3 font-medium">Fee</th>
            <th className="px-5 py-3 font-medium">Status</th>
            <th className="px-5 py-3 font-medium">Date</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-neutral-100">
          {rows.length === 0 ? (
            <tr>
              <td colSpan={8} className="px-5 py-12 text-center text-sm text-neutral-500">
                No saves yet. When a customer accepts an offer and pays their next invoice, it shows up here.
              </td>
            </tr>
          ) : (
            rows.map((row) => (
              <tr key={row.id}>
                <td className="px-5 py-3 font-mono text-xs text-ink">{row.receipt_number}</td>
                <td className="px-5 py-3 capitalize text-neutral-700">{row.type}</td>
                <td className="px-5 py-3 font-mono text-xs text-neutral-600">{row.stripe_customer_id}</td>
                <td className="px-5 py-3 text-neutral-700">{row.type === "cancel" ? describeOfferRecord(row.offer) : "—"}</td>
                <td className="px-5 py-3 tabular-nums text-ink">
                  {row.type === "cancel"
                    ? `${formatCents(Number(row.saved_mrr_cents), row.currency)}/mo`
                    : formatCents(Number(row.recovered_amount_cents), row.currency)}
                </td>
                <td className="px-5 py-3 tabular-nums text-ink">{formatCents(Number(row.fee_cents))}</td>
                <td className="px-5 py-3">
                  <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_STYLES[row.status]}`}>
                    {row.status.replace("_", " ")}
                  </span>
                </td>
                <td className="px-5 py-3 text-neutral-500">{new Date(row.verified_at ?? row.created_at).toLocaleDateString("en-US")}</td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}
