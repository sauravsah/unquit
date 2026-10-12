import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { DashboardShell } from "@/components/DashboardShell";
import { Paper, Row, Rule } from "@/components/Paper";
import { PrintButton } from "@/components/PrintButton";
import { SaveStatusBadge } from "@/components/SaveStatus";
import { getOrCreateAccount } from "@/lib/accounts";
import { describeDeclineCode } from "@/lib/dunning/declines";
import { describeOfferRecord } from "@/lib/flows/describe";
import { EVIDENCE_LABELS, type EvidenceFailure } from "@/lib/ledger/disputes";
import { DISPUTE_CATEGORY_LABELS } from "@/lib/ledger/emails";
import { monthLabel } from "@/lib/ledger/fees";
import { buildTimeline, feeLineViews, loadReceipt, stripeDashboardUrl, verifyingInvoiceIds, type TimelineTone } from "@/lib/ledger/receipt";
import type { DisputeCategory } from "@/lib/ledger/types";
import { formatCents } from "@/lib/pricing";
import { verifyWindowDays } from "@/lib/saves/verify";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const DISPUTE_BANNERS: Record<string, { tone: "good" | "bad" | "neutral"; text: string }> = {
  auto_accepted: { tone: "good", text: "Dispute accepted automatically: the Stripe evidence didn't hold up, so every fee on this save is reversed." },
  in_review: { tone: "neutral", text: "Dispute received. The fees are on hold while we review it; we'll email you the outcome." },
  already_open: { tone: "neutral", text: "This save already has an open dispute." },
  no_fee: { tone: "neutral", text: "There's no fee on this save to dispute." },
  invalid: { tone: "bad", text: "Please choose a reason (and add a note if you picked “Other”)." },
  error: { tone: "bad", text: "We couldn't open the dispute. Please try again." },
};

const TONE_DOT: Record<TimelineTone, string> = {
  done: "bg-brand",
  pending: "bg-amber-400",
  bad: "bg-red-500",
  neutral: "bg-neutral-300",
};

const CLAWBACK_LABEL: Record<string, string> = {
  refund: "Refund",
  credit_note: "Credit note",
  dispute_lost: "Chargeback lost",
  dispute_accepted: "Your dispute (accepted)",
  dispute_auto: "Your dispute (automatic check)",
};

const LOST_REASON: Record<string, string> = {
  expired: "Expired: no qualifying paid invoice in time",
  superseded: "Superseded by a newer cancel session",
  customer_canceled: "Customer cancelled before paying again",
};

function fmtDate(iso: string | null): string {
  if (!iso) return "";
  return new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", timeZone: "UTC" }) + " UTC";
}

export default async function ReceiptPage({ params, searchParams }: { params: { receipt_number: string }; searchParams: { dispute?: string } }) {
  const supabase = createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect(`/login?next=/dashboard/saves/${encodeURIComponent(params.receipt_number)}`);

  const account = await getOrCreateAccount(supabase, user);
  const data = await loadReceipt(supabase, account.id, decodeURIComponent(params.receipt_number));
  if (!data) notFound();

  const { save, session, dunningCase } = data;
  const lines = feeLineViews(data);
  const timeline = buildTimeline(data, verifyWindowDays(process.env.VERIFY_WINDOW_DAYS));
  const invoices = verifyingInvoiceIds(data);
  const live = data.stripeLivemode;
  const openDispute = data.disputes.find((d) => d.status === "open") ?? null;
  const banner = searchParams.dispute ? DISPUTE_BANNERS[searchParams.dispute] : undefined;
  const totalEarned = lines.reduce((a, l) => a + l.amountCents, 0);
  const totalClawed = lines.reduce((a, l) => a + l.clawedBackCents, 0);
  const canDispute = save.status === "verified";
  const email = save.customer_email ?? dunningCase?.customer_email ?? null;

  return (
    <DashboardShell email={user.email} active="/dashboard">
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3 print:hidden">
        <Link href="/dashboard" className="text-sm font-medium text-neutral-600 hover:text-ink">
          ← Saves ledger
        </Link>
        <PrintButton />
      </div>

      {banner ? (
        <p
          role="status"
          className={`mx-auto mb-6 max-w-2xl rounded-lg border px-4 py-3 text-sm print:hidden ${
            banner.tone === "good" ? "border-brand/30 bg-brand-light text-ink" : banner.tone === "bad" ? "border-red-200 bg-red-50 text-red-800" : "border-neutral-200 bg-white text-neutral-700"
          }`}
        >
          {banner.text}
        </p>
      ) : null}

      <Paper>
        <header className="flex items-start justify-between gap-4">
          <div>
            <p className="text-lg font-semibold tracking-tight text-ink">
              unquit<span className="text-brand">.</span>
            </p>
            <p className="mt-0.5 text-xs uppercase tracking-widest text-neutral-500">Save receipt</p>
          </div>
          <div className="text-right">
            <p className="font-mono text-base font-semibold text-ink">{save.receipt_number}</p>
            <div className="mt-1">
              <SaveStatusBadge status={save.status} ended={!!save.ended_at} />
            </div>
          </div>
        </header>

        <Rule />

        <dl>
          <Row label="Type">{save.type === "cancel" ? "Cancel save (20% × first 3 paid months)" : "Failed-payment recovery (10%, once)"}</Row>
          <Row label="Customer">
            {email ? <span className="block">{email}</span> : null}
            <a href={stripeDashboardUrl("customers", save.stripe_customer_id, live)} target="_blank" rel="noreferrer" className="font-mono text-xs text-brand hover:text-brand-dark">
              {save.stripe_customer_id}
            </a>
          </Row>
          {save.stripe_subscription_id ? (
            <Row label="Subscription">
              <a href={stripeDashboardUrl("subscriptions", save.stripe_subscription_id, live)} target="_blank" rel="noreferrer" className="font-mono text-xs text-brand hover:text-brand-dark">
                {save.stripe_subscription_id}
              </a>
            </Row>
          ) : null}
          {save.type === "cancel" ? (
            <>
              <Row label="Reason">
                {session?.reason_label ?? session?.reason ?? "—"}
                {session?.reason_detail ? <span className="block text-xs text-neutral-500">“{session.reason_detail}”</span> : null}
              </Row>
              <Row label="Offer accepted">{describeOfferRecord(save.offer)}</Row>
              <Row label="Saved MRR" strong>
                {formatCents(Number(save.saved_mrr_cents), save.currency)}/mo
              </Row>
            </>
          ) : (
            <>
              <Row label="Decline">{dunningCase?.decline_code ? `${describeDeclineCode(dunningCase.decline_code)} (${dunningCase.decline_code})` : "—"}</Row>
              <Row label="Attribution">{save.attributed_via === "update_link" ? "Card-update link" : "unquit retry after an email click"}</Row>
              <Row label="Recovered" strong>
                {formatCents(Number(save.recovered_amount_cents), save.currency)}
              </Row>
            </>
          )}
          <Row label="Verified by">
            {invoices.length === 0 ? (
              <span className="text-neutral-500">Not yet: waiting for a paid invoice</span>
            ) : (
              invoices.map((id) => (
                <a key={id} href={stripeDashboardUrl("invoices", id, live)} target="_blank" rel="noreferrer" className="block font-mono text-xs text-brand hover:text-brand-dark">
                  {id} ↗
                </a>
              ))
            )}
          </Row>
          {save.lost_reason ? <Row label="Lost">{LOST_REASON[save.lost_reason] ?? save.lost_reason}</Row> : null}
        </dl>

        <Rule />

        <h2 className="text-xs font-semibold uppercase tracking-widest text-neutral-500">Fees</h2>
        {lines.length === 0 ? (
          <p className="mt-3 text-sm text-neutral-500">No fees. {save.status === "pending" ? "Nothing is charged until the next invoice is paid." : ""}</p>
        ) : (
          <table className="mt-3 w-full text-sm">
            <thead className="text-xs text-neutral-500">
              <tr>
                <th className="py-1 text-left font-medium">Month</th>
                <th className="py-1 text-left font-medium">Invoice</th>
                <th className="py-1 text-right font-medium">Fee</th>
                <th className="py-1 text-right font-medium">Clawed back</th>
                <th className="py-1 text-right font-medium">Net</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-dashed divide-neutral-200">
              {lines.map((l) => (
                <tr key={l.monthIndex}>
                  <td className="py-2 align-top">
                    {save.type === "cancel" ? `Month ${l.monthIndex}` : "Recovery"}
                    <span className="block text-xs text-neutral-500">{monthLabel(l.billingMonth)}</span>
                  </td>
                  <td className="py-2 align-top font-mono text-xs">
                    {l.invoiceId ? (
                      <a href={stripeDashboardUrl("invoices", l.invoiceId, live)} target="_blank" rel="noreferrer" className="text-brand hover:text-brand-dark">
                        {l.invoiceId}
                      </a>
                    ) : (
                      "—"
                    )}
                    {l.held ? <span className="block font-sans text-amber-700">On hold: {l.holdReason}</span> : null}
                    {l.statement ? (
                      <Link href={`/dashboard/billing/${l.statement.slug}`} className="block font-sans text-neutral-500 hover:text-ink">
                        Billed on {monthLabel(l.statement.month)}
                      </Link>
                    ) : null}
                  </td>
                  <td className="py-2 text-right align-top tabular-nums">{formatCents(l.amountCents)}</td>
                  <td className="py-2 text-right align-top tabular-nums text-red-700">{l.clawedBackCents ? `−${formatCents(l.clawedBackCents)}` : "—"}</td>
                  <td className="py-2 text-right align-top font-medium tabular-nums">{formatCents(l.netCents)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t border-neutral-300">
                <td colSpan={2} className="pt-3 text-sm font-semibold text-ink">
                  Total
                </td>
                <td className="pt-3 text-right tabular-nums">{formatCents(totalEarned)}</td>
                <td className="pt-3 text-right tabular-nums text-red-700">{totalClawed ? `−${formatCents(totalClawed)}` : "—"}</td>
                <td className="pt-3 text-right font-semibold tabular-nums text-ink">{formatCents(totalEarned - totalClawed)}</td>
              </tr>
            </tfoot>
          </table>
        )}
        {save.type === "cancel" && lines.length > 0 && lines.length < 3 && save.status !== "lost" && !save.ended_at ? (
          <p className="mt-2 text-xs text-neutral-500">
            Up to {3 - lines.length} more month{3 - lines.length === 1 ? "" : "s"} at {formatCents(lines[0]!.amountCents)} as the customer keeps paying. Then it&apos;s free.
          </p>
        ) : null}
        <p className="mt-2 text-xs text-neutral-500">Fees round down to the cent. Your whole month is capped at $299.</p>

        {data.clawbacks.length > 0 ? (
          <>
            <Rule />
            <h2 className="text-xs font-semibold uppercase tracking-widest text-neutral-500">Clawbacks</h2>
            <dl className="mt-2">
              {data.clawbacks.map((c) => (
                <Row key={c.id} label={`${CLAWBACK_LABEL[c.kind] ?? c.kind} · ${fmtDate(c.created_at)}`}>
                  −{formatCents(Number(c.amount_cents))}
                </Row>
              ))}
            </dl>
          </>
        ) : null}

        <Rule />

        <h2 className="text-xs font-semibold uppercase tracking-widest text-neutral-500">Timeline</h2>
        <ol className="mt-4 space-y-4">
          {timeline.map((item, i) => (
            <li key={i} className="relative flex gap-3 pl-1">
              <span aria-hidden className={`mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full ${TONE_DOT[item.tone]}`} />
              <div className="min-w-0">
                <p className="text-sm font-medium text-ink">{item.title}</p>
                {item.detail ? <p className="text-xs text-neutral-600">{item.detail}</p> : null}
                {item.at ? <p className="text-xs text-neutral-400">{fmtDate(item.at)}</p> : null}
              </div>
            </li>
          ))}
        </ol>

        {data.disputes.length > 0 ? (
          <>
            <Rule />
            <h2 className="text-xs font-semibold uppercase tracking-widest text-neutral-500">Disputes</h2>
            <ul className="mt-3 space-y-3">
              {data.disputes.map((d) => {
                const failed = ((d.evidence as { failed?: EvidenceFailure[] } | null)?.failed ?? []).map((f) => EVIDENCE_LABELS[f]);
                return (
                  <li key={d.id} className="rounded-lg border border-neutral-200 p-3 text-sm">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="font-medium text-ink">{DISPUTE_CATEGORY_LABELS[d.category as DisputeCategory]}</span>
                      <span
                        className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                          d.status === "open" ? "bg-amber-100 text-amber-800" : d.status === "accepted" ? "bg-brand-light text-brand-dark" : "bg-neutral-100 text-neutral-700"
                        }`}
                      >
                        {d.status === "open" ? "In review · fees on hold" : d.status === "accepted" ? "Accepted · fees reversed" : "Rejected · fee stands"}
                      </span>
                    </div>
                    {d.note ? <p className="mt-1 text-neutral-600">“{d.note}”</p> : null}
                    <p className="mt-1 text-xs text-neutral-400">Opened {fmtDate(d.created_at)}</p>
                    {d.status !== "open" ? (
                      <p className="mt-2 text-xs text-neutral-600">
                        {d.resolution === "auto" ? `Automatic check: ${failed.join("; ") || "evidence didn't hold up"}.` : d.resolution_note ? `Reviewer: “${d.resolution_note}”` : "Reviewed by unquit."}{" "}
                        <span className="text-neutral-400">{fmtDate(d.resolved_at)}</span>
                      </p>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          </>
        ) : null}

        {canDispute ? (
          <div className="print:hidden">
            <Rule />
            <details className="group">
              <summary className="inline-flex cursor-pointer select-none items-center rounded-lg border border-neutral-300 bg-white px-3 py-2 text-sm font-medium text-neutral-700 hover:border-neutral-400 hover:text-ink">
                Dispute this save
              </summary>
              <form action={`/api/saves/${encodeURIComponent(save.receipt_number)}/dispute`} method="post" className="mt-4 space-y-4">
                <fieldset>
                  <legend className="text-sm font-medium text-ink">Why shouldn&apos;t this save count?</legend>
                  <div className="mt-2 space-y-2">
                    {(Object.entries(DISPUTE_CATEGORY_LABELS) as [DisputeCategory, string][]).map(([value, label], i) => (
                      <label key={value} className="flex items-center gap-2 text-sm text-neutral-700">
                        <input type="radio" name="category" value={value} required defaultChecked={i === 0} className="accent-[#16A34A]" />
                        {label}
                      </label>
                    ))}
                  </div>
                </fieldset>
                <div>
                  <label htmlFor="dispute-note" className="text-sm font-medium text-ink">
                    Note <span className="font-normal text-neutral-500">(required for “Other”)</span>
                  </label>
                  <textarea
                    id="dispute-note"
                    name="note"
                    rows={3}
                    maxLength={2000}
                    className="mt-1 w-full rounded-lg border border-neutral-300 px-3 py-2 text-sm focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand"
                    placeholder="Anything that helps us check, e.g. “they emailed us they were staying anyway”."
                  />
                </div>
                <p className="text-xs text-neutral-500">
                  The fees on this save are held straight away. We check the Stripe invoices automatically; if the proof doesn&apos;t hold up the fee is
                  reversed on the spot, otherwise a person reviews it and emails you.
                </p>
                <button className="rounded-lg bg-brand px-4 py-2 text-sm font-semibold text-white hover:bg-brand-dark">Send dispute</button>
              </form>
            </details>
          </div>
        ) : openDispute ? (
          <p className="mt-6 text-xs text-neutral-500 print:hidden">A dispute is open on this save. Its fees are on hold until it&apos;s resolved.</p>
        ) : null}

        <Rule />
        <p className="text-center text-xs text-neutral-400">
          Receipt {save.receipt_number} · created {fmtDate(save.created_at)} · unquit charges only for proof
        </p>
      </Paper>
    </DashboardShell>
  );
}
