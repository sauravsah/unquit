import Link from "next/link";
import { redirect } from "next/navigation";
import { CapProgress } from "@/components/CapProgress";
import { ConnectFirst, DashboardShell } from "@/components/DashboardShell";
import { StatCard } from "@/components/StatCard";
import { getOrCreateAccount } from "@/lib/accounts";
import { loadBillingPage } from "@/lib/billing/dashboard";
import { finishSetupSession, syncPlatformInvoice } from "@/lib/billing/platform";
import { serverEnv } from "@/lib/env";
import { loadRunningTotal } from "@/lib/ledger/dashboard";
import { monthLabel, monthSlug } from "@/lib/ledger/fees";
import { formatCents, MONTHLY_FEE_CAP_CENTS } from "@/lib/pricing";
import { getStripe } from "@/lib/stripe/client";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const SETUP_BANNERS: Record<string, { tone: "good" | "bad" | "neutral"; text: string }> = {
  success: { tone: "good", text: "Card saved. unquit's monthly invoice will be charged to it automatically." },
  pending: { tone: "neutral", text: "Stripe is still confirming your card. Refresh in a moment." },
  cancelled: { tone: "neutral", text: "No card added. You can add one any time." },
  error: { tone: "bad", text: "We couldn't open Stripe Checkout. Please try again." },
};

const INVOICE_STATUS: Record<string, { label: string; style: string }> = {
  paid: { label: "Paid", style: "bg-brand-light text-brand-dark" },
  open: { label: "Due", style: "bg-amber-100 text-amber-800" },
  draft: { label: "Preparing", style: "bg-neutral-100 text-neutral-600" },
  void: { label: "Void", style: "bg-neutral-100 text-neutral-500" },
  uncollectible: { label: "Unpaid", style: "bg-red-50 text-red-700" },
};

export default async function BillingPage({ searchParams }: { searchParams: { setup?: string; session_id?: string } }) {
  const supabase = createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login?next=/dashboard/billing");

  const account = await getOrCreateAccount(supabase, user);
  const connected = account.stripe_connection_status === "connected" && !!account.stripe_account_id;

  // Back from Stripe Checkout (setup mode): make the card the invoice default.
  let setupState = searchParams.setup;
  if (setupState === "success" && searchParams.session_id) {
    try {
      const ok = await finishSetupSession(createSupabaseAdminClient(), getStripe(), account.id, searchParams.session_id);
      if (!ok) setupState = "pending";
    } catch (error) {
      console.error("[billing] finishing Checkout failed", error);
      setupState = "error";
    }
  }

  let { account: billing, periods } = await loadBillingPage(supabase, account.id);

  // Without the optional platform webhook, refresh unpaid invoices' status from Stripe.
  if (!serverEnv.stripePlatformWebhookSecret()) {
    const open = periods.filter((p) => p.stripe_invoice_id && p.invoice_status !== "paid" && p.invoice_status !== "void").slice(0, 3);
    if (open.length > 0) {
      try {
        const admin = createSupabaseAdminClient();
        for (const p of open) await syncPlatformInvoice(admin, await getStripe().invoices.retrieve(p.stripe_invoice_id!));
        ({ account: billing, periods } = await loadBillingPage(supabase, account.id));
      } catch (error) {
        console.warn("[billing] refreshing invoice status failed", error);
      }
    }
  }

  const running = await loadRunningTotal(supabase, account.id);
  const banner = setupState ? SETUP_BANNERS[setupState] : undefined;
  const hasCard = billing.billing_pm_status === "active";

  return (
    <DashboardShell email={user.email} active="/dashboard/billing" showTabs={connected}>
      {!connected && periods.length === 0 ? (
        <ConnectFirst />
      ) : (
        <div className="space-y-8">
          {banner ? (
            <p
              role="status"
              className={`rounded-lg border px-4 py-3 text-sm ${
                banner.tone === "good" ? "border-brand/30 bg-brand-light text-ink" : banner.tone === "bad" ? "border-red-200 bg-red-50 text-red-800" : "border-neutral-200 bg-white text-neutral-700"
              }`}
            >
              {banner.text}
            </p>
          ) : null}

          <section>
            <h1 className="text-2xl font-semibold tracking-tight text-ink">Billing</h1>
            <p className="mt-1 max-w-2xl text-sm text-neutral-500">
              No base fee. You pay 20% of saved MRR for a saved customer&apos;s first 3 paid months, and 10% of failed payments unquit recovers.
              Never more than {formatCents(MONTHLY_FEE_CAP_CENTS)} in a month. One invoice on the 1st for the month before.
            </p>
          </section>

          <section className="grid gap-4 lg:grid-cols-3">
            <div className="rounded-xl border border-neutral-200 bg-white p-5 lg:col-span-2">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <p className="text-sm text-neutral-500">{monthLabel(running.month)} so far</p>
                <Link href={`/dashboard/billing/${monthSlug(running.month)}`} className="text-xs font-medium text-brand hover:text-brand-dark">
                  See the running statement →
                </Link>
              </div>
              <p className="mt-2 text-3xl font-semibold tabular-nums text-ink">{formatCents(running.totalCents)}</p>
              <div className="mt-3">
                <CapProgress cents={running.cappedCents} />
              </div>
              <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-4">
                <div>
                  <dt className="text-xs text-neutral-500">Cancel saves</dt>
                  <dd className="tabular-nums text-ink">{formatCents(running.cancelFeesCents)}</dd>
                </div>
                <div>
                  <dt className="text-xs text-neutral-500">Failed payments</dt>
                  <dd className="tabular-nums text-ink">{formatCents(running.dunningFeesCents)}</dd>
                </div>
                <div>
                  <dt className="text-xs text-neutral-500">Credits</dt>
                  <dd className="tabular-nums text-ink">{running.creditAppliedCents ? `−${formatCents(running.creditAppliedCents)}` : "—"}</dd>
                </div>
                <div>
                  <dt className="text-xs text-neutral-500">On hold (disputes)</dt>
                  <dd className="tabular-nums text-ink">{running.heldCents ? formatCents(running.heldCents) : "—"}</dd>
                </div>
              </dl>
            </div>

            <div className="rounded-xl border border-neutral-200 bg-white p-5">
              <p className="text-sm text-neutral-500">Payment method</p>
              {hasCard ? (
                <p className="mt-2 text-lg font-semibold text-ink">
                  <span className="capitalize">{billing.billing_pm_brand ?? "Card"}</span> •••• {billing.billing_pm_last4 ?? "····"}
                </p>
              ) : (
                <p className="mt-2 text-lg font-semibold text-ink">No card yet</p>
              )}
              <p className="mt-1 text-xs text-neutral-500">
                {hasCard
                  ? "Charged automatically when each monthly invoice is ready."
                  : "Without a card, Stripe emails each invoice with a link to pay within 14 days."}
              </p>
              <form action="/api/billing/setup" method="post" className="mt-4">
                <button className="rounded-lg bg-brand px-4 py-2 text-sm font-semibold text-white hover:bg-brand-dark">
                  {hasCard ? "Replace card" : "Add a card"}
                </button>
              </form>
              <p className="mt-2 text-xs text-neutral-400">Secure Stripe Checkout. Nothing is charged now.</p>
            </div>
          </section>

          <section className="grid gap-4 sm:grid-cols-3">
            <StatCard label="Statements" value={String(periods.length)} hint="One per month since you connected" />
            <StatCard
              label="Billed to date"
              value={formatCents(periods.reduce((a, p) => a + Number(p.total_cents), 0))}
              hint="After the cap and credits"
            />
            <StatCard
              label="Saved by the cap"
              value={formatCents(periods.reduce((a, p) => a + Number(p.cap_discount_cents), 0))}
              hint={`Fees above ${formatCents(MONTHLY_FEE_CAP_CENTS)}/month you never paid`}
              emphasis
            />
          </section>

          <section className="rounded-xl border border-neutral-200 bg-white">
            <div className="border-b border-neutral-200 px-5 py-4">
              <h2 className="text-base font-semibold text-ink">Past statements</h2>
            </div>
            <div className="overflow-x-auto">
              <table className="min-w-full text-left text-sm">
                <thead className="text-xs uppercase tracking-wide text-neutral-500">
                  <tr>
                    <th className="px-5 py-3 font-medium">Month</th>
                    <th className="px-5 py-3 font-medium">Fees</th>
                    <th className="px-5 py-3 font-medium">Cap / credits</th>
                    <th className="px-5 py-3 font-medium">Total</th>
                    <th className="px-5 py-3 font-medium">Invoice</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-neutral-100">
                  {periods.length === 0 ? (
                    <tr>
                      <td colSpan={5} className="px-5 py-12 text-center text-sm text-neutral-500">
                        Your first statement arrives on the 1st of next month.
                      </td>
                    </tr>
                  ) : (
                    periods.map((p) => {
                      const st = p.status === "zero" ? { label: "Nothing to pay", style: "bg-neutral-100 text-neutral-600" } : INVOICE_STATUS[p.invoice_status ?? ""] ?? { label: p.status === "failed" ? "Retrying" : "Preparing", style: "bg-neutral-100 text-neutral-600" };
                      return (
                        <tr key={p.id}>
                          <td className="px-5 py-3">
                            <Link href={`/dashboard/billing/${monthSlug(p.period_month)}`} className="font-medium text-brand hover:text-brand-dark">
                              {monthLabel(p.period_month)}
                            </Link>
                          </td>
                          <td className="px-5 py-3 tabular-nums text-ink">{formatCents(Number(p.gross_cents))}</td>
                          <td className="px-5 py-3 tabular-nums text-neutral-600">
                            {Number(p.cap_discount_cents) + Number(p.credit_applied_cents) > 0
                              ? `−${formatCents(Number(p.cap_discount_cents) + Number(p.credit_applied_cents))}`
                              : "—"}
                          </td>
                          <td className="px-5 py-3 font-medium tabular-nums text-ink">{formatCents(Number(p.total_cents))}</td>
                          <td className="px-5 py-3">
                            <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${st.style}`}>{st.label}</span>
                            {p.hosted_invoice_url ? (
                              <a href={p.hosted_invoice_url} target="_blank" rel="noreferrer" className="ml-3 text-xs font-medium text-brand hover:text-brand-dark">
                                View invoice ↗
                              </a>
                            ) : null}
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          </section>
        </div>
      )}
    </DashboardShell>
  );
}
