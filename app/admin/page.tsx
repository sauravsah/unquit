import { notFound, redirect } from "next/navigation";
import { PageHeader } from "@/components/DashboardShell";
import { Notice, type NoticeTone } from "@/components/dashboard/Notice";
import { Logo } from "@/components/Logo";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Label, Textarea } from "@/components/ui/input";
import { loadAdminQueue, type AdminDispute } from "@/lib/admin";
import { adminCharges, type AdminChargeView } from "@/lib/billing/dodo/service";
import { adminPauses, type AdminPauseView } from "@/lib/billing/pause";
import { monthLabel } from "@/lib/ledger/fees";
import { isAdminEmail } from "@/lib/env";
import { EVIDENCE_LABELS, type EvidenceFailure, type EvidenceReport } from "@/lib/ledger/disputes";
import { DISPUTE_CATEGORY_LABELS, saveSummary } from "@/lib/ledger/emails";
import { describeOfferRecord } from "@/lib/flows/describe";
import { formatCents } from "@/lib/pricing";
import { getSessionUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db";

export const dynamic = "force-dynamic";

const RESULTS: Record<string, string> = {
  accepted: "Accepted. The fees are reversed and the founder has been emailed.",
  rejected: "Rejected. The holds are lifted and the founder has been emailed your note.",
  note_required: "Add a note for the founder before rejecting.",
  already_resolved: "Someone already resolved that dispute.",
  bad_decision: "Pick accept or reject.",
  not_found: "That dispute doesn't exist.",
  error: "Something went wrong. Please try again.",
};

const RESULT_TONE: Record<string, NoticeTone> = {
  accepted: "good",
  rejected: "good",
  note_required: "bad",
  bad_decision: "bad",
  not_found: "bad",
  error: "bad",
};

/**
 * The dispute review queue. Only sign-in emails listed in ADMIN_EMAILS get
 * in; everyone else sees a 404. Its queries are deliberately not scoped to
 * one account, because admins review every founder's disputes.
 */
export default async function AdminPage({ searchParams }: { searchParams: { result?: string; billing?: string } }) {
  const db = getDb();
  const user = await getSessionUser();
  if (!user) redirect("/login?next=/admin");
  if (!isAdminEmail(user.email)) notFound();

  const [{ open, recent }, charges, pauses] = await Promise.all([
    loadAdminQueue(db),
    adminCharges(db).catch((): AdminChargeView[] => []),
    adminPauses(db).catch((): AdminPauseView[] => []),
  ]);
  const result = searchParams.result ? RESULTS[searchParams.result] : undefined;

  return (
    <div className="min-h-screen bg-surface">
      <div className="sticky top-0 z-20 border-b border-border bg-background/80 backdrop-blur">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-3 px-4 py-3 sm:px-6">
          <div className="flex items-center gap-3">
            <Logo href="/admin" />
            <Badge tone="outline" className="bg-foreground text-background">
              admin
            </Badge>
          </div>
          <span className="truncate text-sm text-muted-foreground">{user.email}</span>
        </div>
      </div>
      <main className="mx-auto max-w-5xl space-y-8 px-4 py-8 sm:px-6 sm:py-10">
        <PageHeader
          title="Dispute review"
          className="mb-0"
          badge={open.length > 0 ? <Badge tone="warning" dot="pulse">{open.length} open</Badge> : <Badge tone="success" dot>Queue clear</Badge>}
          description={
            <>
              Disputes the automatic checks couldn&apos;t settle. Their fees are on hold until you decide. Accept = every fee on the save is reversed.
              Reject = the holds are lifted and the fees stand (a note is required: the founder sees it).
            </>
          }
        />

        {result ? <Notice tone={RESULT_TONE[searchParams.result ?? ""] ?? "neutral"}>{result}</Notice> : null}

        <section aria-labelledby="open-heading" className="space-y-4">
          <h2 id="open-heading" className="text-base font-semibold tracking-tight text-foreground">
            Open ({open.length})
          </h2>
          {open.length === 0 ? (
            <Card>
              <EmptyState compact art="receipts" title="Nothing to review." description="New disputes the automatic checks can't settle land here." />
            </Card>
          ) : (
            open.map((d) => <OpenDispute key={d.id} d={d} />)
          )}
        </section>

        <BillingCharges charges={charges} result={searchParams.billing} />

        <AccountPauses pauses={pauses} />

        <section aria-labelledby="recent-heading">
          <Card className="overflow-hidden">
            <CardHeader>
              <div>
                <CardTitle id="recent-heading" className="text-base">
                  Recently resolved
                </CardTitle>
                <CardDescription>Accepted and rejected disputes, newest first</CardDescription>
              </div>
            </CardHeader>
            <div className="overflow-x-auto">
              <table className="min-w-full border-separate border-spacing-0 text-left text-sm">
                <caption className="sr-only">Recently resolved disputes</caption>
                <thead>
                  <tr>
                    {["Receipt", "Founder", "Reason", "Outcome", "By"].map((h) => (
                      <th
                        key={h}
                        scope="col"
                        className="whitespace-nowrap border-b border-border px-5 py-2.5 text-2xs font-medium uppercase tracking-wider text-muted-foreground"
                      >
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {recent.length === 0 ? (
                    <tr>
                      <td colSpan={5} className="px-5 py-10 text-center text-sm text-muted-foreground">
                        Nothing resolved yet.
                      </td>
                    </tr>
                  ) : (
                    recent.map((d) => (
                      <tr key={d.id} className="group transition-colors hover:bg-muted/50">
                        <td className="whitespace-nowrap border-b border-border/70 px-5 py-3 font-mono text-xs text-foreground group-last:border-b-0">{d.save?.receipt_number}</td>
                        <td className="border-b border-border/70 px-5 py-3 text-foreground group-last:border-b-0">{d.accountName ?? d.account_id}</td>
                        <td className="border-b border-border/70 px-5 py-3 text-muted-foreground group-last:border-b-0">{DISPUTE_CATEGORY_LABELS[d.category]}</td>
                        <td className="border-b border-border/70 px-5 py-3 group-last:border-b-0">
                          <Badge tone={d.status === "accepted" ? "success" : d.status === "rejected" ? "neutral" : "warning"} dot className="capitalize">
                            {d.status} {d.resolution === "auto" ? "(auto)" : ""}
                          </Badge>
                        </td>
                        <td className="border-b border-border/70 px-5 py-3 text-xs text-muted-foreground group-last:border-b-0">{d.resolved_by}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </Card>
        </section>
      </main>
    </div>
  );
}

function OpenDispute({ d }: { d: AdminDispute }) {
  const s = d.save;
  const evidence = d.evidence as EvidenceReport | null;
  return (
    <Card className="overflow-hidden">
      <article aria-labelledby={`dispute-${d.id}`}>
        <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border px-5 py-4">
          <div className="min-w-0 space-y-1">
            <p id={`dispute-${d.id}`} className="break-all font-mono text-sm font-semibold text-foreground">
              {s?.receipt_number}
            </p>
            <p className="text-sm text-muted-foreground">
              {d.accountName ?? d.account_id} · {s ? saveSummary(s) : ""} · fee{" "}
              <span className="font-medium tabular-nums text-warning">{formatCents(Number(s?.fee_cents ?? 0))} on hold</span>
            </p>
            {s?.type === "cancel" ? <p className="text-xs text-muted-foreground">Offer: {describeOfferRecord(s.offer)}</p> : null}
            <p className="break-all text-xs text-muted-foreground">
              Customer {s?.customer_email ?? ""} <span className="font-mono">{s?.stripe_customer_id}</span>
              {s?.stripe_subscription_id ? <span className="font-mono"> · {s.stripe_subscription_id}</span> : null}
              {s?.stripe_invoice_id ? <span className="font-mono"> · {s.stripe_invoice_id}</span> : null}
            </p>
          </div>
          <Badge tone="warning" dot="pulse">
            {DISPUTE_CATEGORY_LABELS[d.category]}
          </Badge>
        </div>
        <div className="space-y-4 px-5 py-4">
          {d.note ? (
            <blockquote className="rounded-lg border-l-2 border-warning bg-muted/60 px-3 py-2 text-sm text-foreground">“{d.note}”</blockquote>
          ) : null}
          <div className="rounded-lg border border-border bg-surface px-3 py-2.5 text-xs text-muted-foreground">
            <p className="mb-1 text-2xs font-semibold uppercase tracking-wider text-muted-foreground">Automatic checks</p>
            {evidence?.error ? <p className="text-warning">{evidence.error}</p> : null}
            {(evidence?.checks ?? []).map((c) => (
              <p key={c.invoice} className="break-all font-mono">
                {c.invoice}: {c.paid ? "paid" : <span className="font-semibold text-danger">NOT paid</span>}, refunded {formatCents(c.refunded_cents)}, subscription{" "}
                <span className={c.subscription_matches ? "text-brand-text" : "text-danger"}>{c.subscription_matches ? "✓" : "✗"}</span>, customer{" "}
                <span className={c.customer_matches ? "text-brand-text" : "text-danger"}>{c.customer_matches ? "✓" : "✗"}</span>
              </p>
            ))}
            {(evidence?.failed ?? []).map((f) => (
              <p key={f}>{EVIDENCE_LABELS[f as EvidenceFailure]}</p>
            ))}
          </div>
          <form action={`/api/admin/disputes/${d.id}`} method="post" className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor={`note-${d.id}`} className="block">
                Note to the founder
              </Label>
              <Textarea id={`note-${d.id}`} name="note" rows={2} maxLength={2000} className="min-h-[72px]" aria-describedby={`note-help-${d.id}`} />
              <p id={`note-help-${d.id}`} className="text-xs text-muted-foreground">
                Required to reject. The founder sees it in the outcome email.
              </p>
            </div>
            <div className="flex flex-col gap-2 sm:flex-row sm:gap-3">
              <Button name="decision" value="accept" type="submit" variant="brand">
                Accept · reverse fees
              </Button>
              <Button name="decision" value="reject" type="submit" variant="secondary">
                Reject · fee stands
              </Button>
            </div>
          </form>
        </div>
      </article>
    </Card>
  );
}

const CHARGE_TONE: Record<string, "success" | "warning" | "neutral" | "danger"> = {
  paid: "success",
  scheduled: "neutral",
  processing: "neutral",
  awaiting_card: "warning",
  retrying: "warning",
  unpaid: "danger",
  refunded: "neutral",
  partially_refunded: "neutral",
};

const shortDate = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "UTC", timeZoneName: "short" }) : "—";

/** unquit's own fee charges through Dodo Payments: every founder, newest first, with each attempt. */
function BillingCharges({ charges, result }: { charges: AdminChargeView[]; result?: string }) {
  const failures = charges.filter((c) => c.status === "unpaid" || c.status === "retrying" || c.status === "awaiting_card");
  return (
    <section id="billing" aria-labelledby="billing-heading">
      <Card className="overflow-hidden">
        <CardHeader>
          <div>
            <CardTitle id="billing-heading" className="text-base">
              Fee charges (Dodo Payments)
            </CardTitle>
            <CardDescription>
              {failures.length > 0 ? `${failures.length} need attention (unpaid, retrying or no card). ` : "No failures. "}
              Retries run at +3, +10 and +17 days; hard declines are never retried. An unpaid statement warns the founder, then pauses Unquit after 3 days; paying resumes it.
            </CardDescription>
          </div>
          <form action="/api/admin/billing" method="post">
            <input type="hidden" name="action" value="run_due" />
            <Button type="submit" variant="secondary" size="sm">
              Run due charges now
            </Button>
          </form>
        </CardHeader>
        {result ? <p className="border-b border-border px-5 py-2 text-xs text-muted-foreground">Last action: {result.replace(/_/g, " ")}</p> : null}
        <div className="overflow-x-auto">
          <table className="min-w-full border-separate border-spacing-0 text-left text-sm">
            <caption className="sr-only">Fee charges</caption>
            <thead>
              <tr>
                {["Founder", "Statement", "Amount", "Status", "Attempts", "Next / paid", ""].map((h) => (
                  <th key={h} scope="col" className="whitespace-nowrap border-b border-border px-5 py-2.5 text-2xs font-medium uppercase tracking-wider text-muted-foreground">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {charges.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-5 py-10 text-center text-sm text-muted-foreground">
                    No charges yet. Statements are charged on the 1st.
                  </td>
                </tr>
              ) : (
                charges.map((c) => (
                  <tr key={c.id} className="group align-top transition-colors hover:bg-muted/50">
                    <td className="border-b border-border/70 px-5 py-3 text-foreground group-last:border-b-0">
                      {c.owner_email ?? c.account_name ?? c.account_id}
                    </td>
                    <td className="whitespace-nowrap border-b border-border/70 px-5 py-3 text-muted-foreground group-last:border-b-0">{monthLabel(c.period_month)}</td>
                    <td className="whitespace-nowrap border-b border-border/70 px-5 py-3 font-medium tabular-nums text-foreground group-last:border-b-0">
                      {formatCents(Number(c.amount_cents))}
                      {Number(c.refunded_cents) > 0 ? <span className="block text-xs font-normal text-muted-foreground">−{formatCents(Number(c.refunded_cents))} refunded</span> : null}
                    </td>
                    <td className="border-b border-border/70 px-5 py-3 group-last:border-b-0">
                      <Badge tone={CHARGE_TONE[c.status] ?? "neutral"} dot>
                        {c.status.replace(/_/g, " ")}
                      </Badge>
                      {c.last_error_code ? <span className="mt-1 block font-mono text-2xs text-danger">{c.last_error_code}{c.hard_declined ? " (hard)" : ""}</span> : null}
                    </td>
                    <td className="border-b border-border/70 px-5 py-3 text-xs text-muted-foreground group-last:border-b-0">
                      {c.attempts.length === 0
                        ? "—"
                        : c.attempts.map((a) => (
                            <span key={a.id} className="block whitespace-nowrap font-mono">
                              #{a.attempt_no} {a.state}
                              {a.error_code ? ` ${a.error_code}` : ""} · {a.dodo_payment_id ?? "no payment"}
                            </span>
                          ))}
                    </td>
                    <td className="whitespace-nowrap border-b border-border/70 px-5 py-3 text-xs text-muted-foreground group-last:border-b-0">
                      {c.status === "paid" ? `Paid ${shortDate(c.paid_at)}` : shortDate(c.next_attempt_at)}
                      {c.receipt_url ? (
                        <a href={c.receipt_url} target="_blank" rel="noreferrer" className="mt-1 block font-medium text-brand-text underline-offset-4 hover:underline">
                          Receipt ↗
                        </a>
                      ) : null}
                    </td>
                    <td className="border-b border-border/70 px-5 py-3 group-last:border-b-0">
                      {c.status === "scheduled" || c.status === "retrying" ? (
                        <form action="/api/admin/billing" method="post">
                          <input type="hidden" name="action" value="charge_now" />
                          <input type="hidden" name="charge_id" value={c.id} />
                          <Button type="submit" variant="ghost" size="sm">
                            Charge now
                          </Button>
                        </form>
                      ) : null}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </Card>
    </section>
  );
}

/** Founders warned about or paused for an unpaid bill, plus a manual pause/resume form. */
function AccountPauses({ pauses }: { pauses: AdminPauseView[] }) {
  return (
    <section id="pauses" aria-labelledby="pauses-heading">
      <Card className="overflow-hidden">
        <CardHeader>
          <div>
            <CardTitle id="pauses-heading" className="text-base">
              Account pauses
            </CardTitle>
            <CardDescription>
              Paused = no cancel-flow offers and no dunning emails; customers can still cancel. Automatic pauses resume when the bill is paid; an
              admin pause only resumes here.
            </CardDescription>
          </div>
          <form action="/api/admin/billing" method="post" className="flex flex-wrap items-center gap-2">
            <label htmlFor="pause-account" className="sr-only">
              Account id or owner email
            </label>
            <input
              id="pause-account"
              name="account"
              required
              placeholder="account id or owner email"
              className="h-8 w-56 rounded-md border border-border bg-background px-2 text-xs text-foreground"
            />
            <Button type="submit" name="action" value="pause" variant="secondary" size="sm">
              Pause
            </Button>
            <Button type="submit" name="action" value="resume" variant="ghost" size="sm">
              Resume
            </Button>
          </form>
        </CardHeader>
        <div className="overflow-x-auto">
          <table className="min-w-full border-separate border-spacing-0 text-left text-sm">
            <caption className="sr-only">Account pauses</caption>
            <thead>
              <tr>
                {["Founder", "State", "Since", "Pauses on", "Outstanding", ""].map((h) => (
                  <th key={h} scope="col" className="whitespace-nowrap border-b border-border px-5 py-2.5 text-2xs font-medium uppercase tracking-wider text-muted-foreground">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {pauses.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-5 py-10 text-center text-sm text-muted-foreground">
                    No founder is warned or paused.
                  </td>
                </tr>
              ) : (
                pauses.map((p) => (
                  <tr key={p.id} className="group align-top transition-colors hover:bg-muted/50">
                    <td className="border-b border-border/70 px-5 py-3 text-foreground group-last:border-b-0">{p.owner_email ?? p.name ?? p.id}</td>
                    <td className="border-b border-border/70 px-5 py-3 group-last:border-b-0">
                      <Badge tone={p.billing_pause_state === "paused" ? "danger" : "warning"} dot>
                        {p.billing_pause_state}
                        {p.billing_pause_source ? ` (${p.billing_pause_source})` : ""}
                      </Badge>
                    </td>
                    <td className="whitespace-nowrap border-b border-border/70 px-5 py-3 text-xs text-muted-foreground group-last:border-b-0">
                      {shortDate(p.billing_paused_at ?? p.billing_pause_warned_at)}
                    </td>
                    <td className="whitespace-nowrap border-b border-border/70 px-5 py-3 text-xs text-muted-foreground group-last:border-b-0">
                      {p.billing_pause_state === "warned" ? shortDate(p.billing_pause_due_at) : "—"}
                    </td>
                    <td className="whitespace-nowrap border-b border-border/70 px-5 py-3 font-medium tabular-nums text-foreground group-last:border-b-0">
                      {formatCents(Number(p.outstanding_cents))}
                    </td>
                    <td className="border-b border-border/70 px-5 py-3 group-last:border-b-0">
                      <form action="/api/admin/billing" method="post">
                        <input type="hidden" name="account" value={p.id} />
                        <Button type="submit" name="action" value="resume" variant="ghost" size="sm">
                          Resume
                        </Button>
                      </form>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </Card>
    </section>
  );
}
