import { ArrowLeft, ChevronDown, Flag } from "lucide-react";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { DashboardShell } from "@/components/DashboardShell";
import { Notice } from "@/components/dashboard/Notice";
import { Paper, Row, Rule, SectionLabel } from "@/components/Paper";
import { PrintButton } from "@/components/PrintButton";
import { SaveStatusBadge } from "@/components/SaveStatus";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label, Textarea } from "@/components/ui/input";
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
import { getSessionUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db";
import { Logo } from "@/components/Logo";

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
  done: "bg-brand ring-brand/15",
  pending: "bg-warning ring-warning/15",
  bad: "bg-danger ring-danger/15",
  neutral: "bg-muted-foreground/50 ring-muted",
};

const CLAWBACK_LABEL: Record<string, string> = {
  refund: "Refund",
  credit_note: "Credit note",
  dispute_lost: "Chargeback lost: fee reversed",
  dispute_accepted: "Dispute accepted: fee reversed",
  dispute_auto: "Dispute accepted automatically: fee reversed",
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
  const db = getDb();
  const user = await getSessionUser();
  if (!user) redirect(`/login?next=/dashboard/saves/${encodeURIComponent(params.receipt_number)}`);

  const account = await getOrCreateAccount(db, user);
  const data = await loadReceipt(db, account.id, decodeURIComponent(params.receipt_number));
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
  // Every fee reversed: the save no longer earns anything, so nothing reads as active.
  const reversed = save.status === "clawed_back";
  const email = save.customer_email ?? dunningCase?.customer_email ?? null;

  const heldLines = lines.filter((l) => l.held).length;
  const linkClass =
    "rounded font-mono text-xs text-brand-text underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

  return (
    <DashboardShell email={user.email} active="/dashboard">
      <div className="mx-auto mb-6 flex max-w-2xl flex-wrap items-center justify-between gap-3 print:hidden">
        <Link
          href="/dashboard#ledger"
          className="inline-flex items-center gap-1.5 rounded-md text-sm font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <ArrowLeft className="h-4 w-4" aria-hidden="true" />
          Saves ledger
        </Link>
        <PrintButton />
      </div>

      {banner ? (
        <Notice tone={banner.tone} className="mx-auto mb-6 max-w-2xl print:hidden">
          {banner.text}
        </Notice>
      ) : null}

      <Paper>
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <Logo href={null} />
            <p className="mt-0.5 text-2xs font-medium uppercase tracking-[0.14em] text-muted-foreground">Save receipt</p>
          </div>
          <div className="sm:text-right">
            <h1 className="break-all font-mono text-base font-semibold text-foreground">{save.receipt_number}</h1>
            <div className="mt-1.5 flex flex-wrap gap-1.5 sm:justify-end">
              <SaveStatusBadge status={save.status} ended={!!save.ended_at} />
              {heldLines > 0 ? (
                <Badge tone="warning" dot="pulse">
                  Fees on hold
                </Badge>
              ) : null}
            </div>
          </div>
        </div>

        <Rule />

        <dl className="divide-y divide-border/60">
          <Row label="Type">{save.type === "cancel" ? "Cancel save (20% × first 3 paid months)" : "Failed-payment recovery (10%, once)"}</Row>
          <Row label="Customer">
            {email ? <span className="block break-all">{email}</span> : null}
            <a href={stripeDashboardUrl("customers", save.stripe_customer_id, live)} target="_blank" rel="noreferrer" className={`${linkClass} break-all`}>
              {save.stripe_customer_id}
            </a>
          </Row>
          {save.stripe_subscription_id ? (
            <Row label="Subscription">
              <a href={stripeDashboardUrl("subscriptions", save.stripe_subscription_id, live)} target="_blank" rel="noreferrer" className={`${linkClass} break-all`}>
                {save.stripe_subscription_id}
              </a>
            </Row>
          ) : null}
          {save.type === "cancel" ? (
            <>
              <Row label="Reason">
                {session?.reason_label ?? session?.reason ?? "—"}
                {session?.reason_detail ? <span className="block text-xs italic text-muted-foreground">“{session.reason_detail}”</span> : null}
              </Row>
              <Row label="Offer accepted">
                <Badge tone="info" className="whitespace-normal text-left">
                  {describeOfferRecord(save.offer)}
                </Badge>
              </Row>
              <Row label="Saved MRR" strong={!reversed}>
                {reversed ? (
                  <>
                    <span className="text-muted-foreground">{formatCents(Number(save.saved_mrr_cents), save.currency)}/mo</span>
                    <span className="block text-xs font-normal text-muted-foreground">Reversed, no fee</span>
                  </>
                ) : (
                  <span className="text-brand-text">{formatCents(Number(save.saved_mrr_cents), save.currency)}/mo</span>
                )}
              </Row>
            </>
          ) : (
            <>
              <Row label="Decline">{dunningCase?.decline_code ? `${describeDeclineCode(dunningCase.decline_code)} (${dunningCase.decline_code})` : "—"}</Row>
              <Row label="Attribution">
                <Badge tone="info">{save.attributed_via === "update_link" ? "Card-update link" : "unquit retry after an email click"}</Badge>
              </Row>
              <Row label="Recovered" strong={!reversed}>
                {reversed ? (
                  <>
                    <span className="text-muted-foreground">{formatCents(Number(save.recovered_amount_cents), save.currency)}</span>
                    <span className="block text-xs font-normal text-muted-foreground">Reversed, no fee</span>
                  </>
                ) : (
                  <span className="text-brand-text">{formatCents(Number(save.recovered_amount_cents), save.currency)}</span>
                )}
              </Row>
            </>
          )}
          <Row label="Verified by">
            {invoices.length === 0 ? (
              <span className="text-muted-foreground">Not yet: waiting for a paid invoice</span>
            ) : (
              invoices.map((id) => (
                <a key={id} href={stripeDashboardUrl("invoices", id, live)} target="_blank" rel="noreferrer" className={`${linkClass} block break-all`}>
                  {id} ↗
                </a>
              ))
            )}
          </Row>
          {save.lost_reason ? <Row label="Lost">{LOST_REASON[save.lost_reason] ?? save.lost_reason}</Row> : null}
        </dl>

        <Rule />

        <SectionLabel id="receipt-fees">Fees</SectionLabel>
        {lines.length === 0 ? (
          <p className="mt-3 text-sm text-muted-foreground">No fees. {save.status === "pending" ? "Nothing is charged until the next invoice is paid." : ""}</p>
        ) : (
          <div className="-mx-1 mt-3 overflow-x-auto px-1">
            <table className="w-full min-w-[520px] text-sm" aria-labelledby="receipt-fees">
              <thead className="text-2xs uppercase tracking-wider text-muted-foreground">
                <tr className="border-b border-border">
                  <th scope="col" className="pb-2 text-left font-medium">Month</th>
                  <th scope="col" className="pb-2 text-left font-medium">Invoice</th>
                  <th scope="col" className="pb-2 text-right font-medium">Fee</th>
                  <th scope="col" className="pb-2 text-right font-medium">Clawed back</th>
                  <th scope="col" className="pb-2 text-right font-medium">Net</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-dashed divide-border">
                {lines.map((l) => (
                  <tr key={l.monthIndex} className={l.held ? "bg-warning-soft/60" : undefined}>
                    <td className="py-3 pr-3 align-top text-foreground">
                      <span className="flex flex-wrap items-center gap-1.5">
                        {save.type === "cancel" ? `Month ${l.monthIndex}` : "Recovery"}
                        {l.held ? (
                          <Badge tone="warning" dot="pulse" title={l.holdReason ?? undefined}>
                            On hold
                          </Badge>
                        ) : null}
                        {l.clawedBackCents > 0 && !l.held ? (
                          <Badge tone="danger" dot>
                            {l.netCents === 0 ? "Reversed" : "Partly clawed back"}
                          </Badge>
                        ) : null}
                      </span>
                      <span className="block text-xs text-muted-foreground">{monthLabel(l.billingMonth)}</span>
                    </td>
                    <td className="py-3 pr-3 align-top font-mono text-xs">
                      {l.invoiceId ? (
                        <a href={stripeDashboardUrl("invoices", l.invoiceId, live)} target="_blank" rel="noreferrer" className={`${linkClass} break-all`}>
                          {l.invoiceId}
                        </a>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                      {l.held ? <span className="mt-0.5 block font-sans font-medium text-warning">On hold: {l.holdReason}</span> : null}
                      {l.statement ? (
                        <Link
                          href={`/dashboard/billing/${l.statement.slug}`}
                          className="mt-0.5 block rounded font-sans text-muted-foreground underline-offset-4 hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        >
                          Billed on {monthLabel(l.statement.month)}
                        </Link>
                      ) : null}
                    </td>
                    <td className="whitespace-nowrap py-3 text-right align-top tabular-nums text-foreground">{formatCents(l.amountCents)}</td>
                    <td className="whitespace-nowrap py-3 text-right align-top tabular-nums text-danger">{l.clawedBackCents ? `−${formatCents(l.clawedBackCents)}` : "—"}</td>
                    <td className="whitespace-nowrap py-3 text-right align-top font-medium tabular-nums text-foreground">{formatCents(l.netCents)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t border-border">
                  <th scope="row" colSpan={2} className="pt-3 text-left text-sm font-semibold text-foreground">
                    Total
                  </th>
                  <td className="whitespace-nowrap pt-3 text-right tabular-nums text-foreground">{formatCents(totalEarned)}</td>
                  <td className="whitespace-nowrap pt-3 text-right tabular-nums text-danger">{totalClawed ? `−${formatCents(totalClawed)}` : "—"}</td>
                  <td className="whitespace-nowrap pt-3 text-right text-base font-semibold tabular-nums text-foreground">{formatCents(totalEarned - totalClawed)}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        )}
        {save.type === "cancel" && lines.length > 0 && lines.length < 3 && save.status !== "lost" && !reversed && !save.ended_at ? (
          <p className="mt-3 text-xs text-muted-foreground">
            Up to {3 - lines.length} more month{3 - lines.length === 1 ? "" : "s"} at {formatCents(lines[0]!.amountCents)} as the customer keeps paying. Then it&apos;s free.
          </p>
        ) : null}
        <p className="mt-2 text-xs text-muted-foreground">
          {reversed ? "Every fee on this save was reversed: you aren't billed for it. " : ""}Fees round down to the cent. Your whole month is capped at
          $299.
        </p>

        {data.clawbacks.length > 0 ? (
          <>
            <Rule />
            <SectionLabel>Clawbacks</SectionLabel>
            <dl className="mt-2 divide-y divide-border/60">
              {data.clawbacks.map((c) => (
                <Row key={c.id} label={`${CLAWBACK_LABEL[c.kind] ?? c.kind} · ${fmtDate(c.created_at)}`}>
                  <span className="font-medium text-danger">−{formatCents(Number(c.amount_cents))}</span>
                </Row>
              ))}
            </dl>
          </>
        ) : null}

        <Rule />

        <SectionLabel>Timeline</SectionLabel>
        <ol className="relative mt-4 space-y-5 before:absolute before:bottom-2 before:left-[9px] before:top-2 before:w-px before:bg-border">
          {timeline.map((item, i) => (
            <li key={i} className="relative flex gap-3">
              <span aria-hidden="true" className="relative z-[1] mt-1 flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full bg-card">
                <span className={`h-2.5 w-2.5 rounded-full ring-4 ${TONE_DOT[item.tone]}`} />
              </span>
              <div className="min-w-0">
                <p className="text-sm font-medium text-foreground">{item.title}</p>
                {item.detail ? <p className="text-xs text-muted-foreground">{item.detail}</p> : null}
                {item.at ? (
                  <p className="mt-0.5 text-2xs text-subtle">
                    <time dateTime={item.at}>{fmtDate(item.at)}</time>
                  </p>
                ) : null}
              </div>
            </li>
          ))}
        </ol>

        {data.disputes.length > 0 ? (
          <>
            <Rule />
            <SectionLabel>Disputes</SectionLabel>
            <ul className="mt-3 space-y-3">
              {data.disputes.map((d) => {
                const failed = ((d.evidence as { failed?: EvidenceFailure[] } | null)?.failed ?? []).map((f) => EVIDENCE_LABELS[f]);
                return (
                  <li key={d.id} className="rounded-xl border border-border bg-surface p-4 text-sm">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="font-medium text-foreground">{DISPUTE_CATEGORY_LABELS[d.category as DisputeCategory]}</span>
                      <Badge tone={d.status === "open" ? "warning" : d.status === "accepted" ? "success" : "neutral"} dot={d.status === "open" ? "pulse" : true}>
                        {d.status === "open" ? "In review · fees on hold" : d.status === "accepted" ? "Accepted · fees reversed" : "Rejected · fee stands"}
                      </Badge>
                    </div>
                    {d.note ? <p className="mt-2 text-muted-foreground">“{d.note}”</p> : null}
                    <p className="mt-1 text-2xs text-subtle">Opened {fmtDate(d.created_at)}</p>
                    {d.status !== "open" ? (
                      <p className="mt-2 border-t border-border pt-2 text-xs text-muted-foreground">
                        {d.resolution === "auto" ? `Automatic check: ${failed.join("; ") || "evidence didn't hold up"}.` : d.resolution_note ? `Reviewer: “${d.resolution_note}”` : "Reviewed by unquit."}{" "}
                        <span className="text-subtle">{fmtDate(d.resolved_at)}</span>
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
            <details className="group rounded-xl border border-border bg-surface open:shadow-xs">
              <summary className="flex cursor-pointer select-none list-none items-center justify-between gap-3 rounded-xl px-4 py-3 text-sm font-medium text-foreground transition-colors hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
                <span className="inline-flex items-center gap-2">
                  <Flag className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
                  Dispute this save
                </span>
                <ChevronDown className="h-4 w-4 text-muted-foreground transition-transform group-open:rotate-180" aria-hidden="true" />
              </summary>
              <form action={`/api/saves/${encodeURIComponent(save.receipt_number)}/dispute`} method="post" className="space-y-5 border-t border-border px-4 pb-5 pt-4">
                <fieldset>
                  <legend className="text-sm font-medium text-foreground">Why shouldn&apos;t this save count?</legend>
                  <div className="mt-3 grid gap-2">
                    {(Object.entries(DISPUTE_CATEGORY_LABELS) as [DisputeCategory, string][]).map(([value, label], i) => (
                      <label
                        key={value}
                        className="flex cursor-pointer items-center gap-3 rounded-lg border border-border bg-card px-3 py-2.5 text-sm text-foreground transition-colors hover:border-input has-[:checked]:border-brand/50 has-[:checked]:bg-brand-soft has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring"
                      >
                        <input type="radio" name="category" value={value} required defaultChecked={i === 0} className="h-4 w-4 shrink-0 accent-[#16A34A] focus-visible:outline-none" />
                        {label}
                      </label>
                    ))}
                  </div>
                </fieldset>
                <div className="space-y-1.5">
                  <Label htmlFor="dispute-note">
                    Note <span className="font-normal text-muted-foreground">(required for “Other”)</span>
                  </Label>
                  <Textarea
                    id="dispute-note"
                    name="note"
                    rows={3}
                    maxLength={2000}
                    aria-describedby="dispute-help"
                    placeholder="Anything that helps us check, e.g. “they emailed us they were staying anyway”."
                  />
                </div>
                <p id="dispute-help" className="text-xs leading-relaxed text-muted-foreground">
                  The fees on this save are held straight away. We check the Stripe invoices automatically; if the proof doesn&apos;t hold up the fee is
                  reversed on the spot, otherwise a person reviews it and emails you.
                </p>
                <Button type="submit" variant="primary">
                  Send dispute
                </Button>
              </form>
            </details>
          </div>
        ) : openDispute ? (
          <p className="mt-6 flex items-center gap-2 rounded-lg border border-warning/25 bg-warning-soft px-3 py-2 text-xs text-warning print:hidden">
            A dispute is open on this save. Its fees are on hold until it&apos;s resolved.
          </p>
        ) : null}

        <Rule />
        <p className="text-center text-2xs text-subtle">
          Receipt {save.receipt_number} · created {fmtDate(save.created_at)} · unquit charges only for proof
        </p>
      </Paper>
    </DashboardShell>
  );
}
