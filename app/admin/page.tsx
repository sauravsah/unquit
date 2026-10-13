import { notFound, redirect } from "next/navigation";
import { Wordmark } from "@/components/Wordmark";
import { loadAdminQueue, type AdminDispute } from "@/lib/admin";
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

/**
 * The dispute review queue. Only sign-in emails listed in ADMIN_EMAILS get
 * in; everyone else sees a 404. Its queries are deliberately not scoped to
 * one account, because admins review every founder's disputes.
 */
export default async function AdminPage({ searchParams }: { searchParams: { result?: string } }) {
  const db = getDb();
  const user = await getSessionUser();
  if (!user) redirect("/login?next=/admin");
  if (!isAdminEmail(user.email)) notFound();

  const { open, recent } = await loadAdminQueue(db);
  const result = searchParams.result ? RESULTS[searchParams.result] : undefined;

  return (
    <div className="min-h-screen bg-neutral-50">
      <header className="border-b border-neutral-200 bg-white">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-6 py-4">
          <div className="flex items-center gap-3">
            <Wordmark href="/admin" />
            <span className="rounded-full bg-ink px-2 py-0.5 text-xs font-medium text-white">admin</span>
          </div>
          <span className="text-sm text-neutral-500">{user.email}</span>
        </div>
      </header>
      <main className="mx-auto max-w-5xl space-y-8 px-6 py-10">
        <section>
          <h1 className="text-2xl font-semibold tracking-tight text-ink">Dispute review</h1>
          <p className="mt-1 text-sm text-neutral-500">
            Disputes the automatic checks couldn&apos;t settle. Their fees are on hold until you decide. Accept = every fee on the save is reversed.
            Reject = the holds are lifted and the fees stand (a note is required: the founder sees it).
          </p>
        </section>

        {result ? (
          <p role="status" className="rounded-lg border border-neutral-200 bg-white px-4 py-3 text-sm text-neutral-700">
            {result}
          </p>
        ) : null}

        <section className="space-y-4">
          <h2 className="text-base font-semibold text-ink">Open ({open.length})</h2>
          {open.length === 0 ? (
            <p className="rounded-xl border border-neutral-200 bg-white px-5 py-10 text-center text-sm text-neutral-500">Nothing to review.</p>
          ) : (
            open.map((d) => <OpenDispute key={d.id} d={d} />)
          )}
        </section>

        <section>
          <h2 className="text-base font-semibold text-ink">Recently resolved</h2>
          <div className="mt-3 overflow-x-auto rounded-xl border border-neutral-200 bg-white">
            <table className="min-w-full text-left text-sm">
              <thead className="text-xs uppercase tracking-wide text-neutral-500">
                <tr>
                  <th className="px-5 py-3 font-medium">Receipt</th>
                  <th className="px-5 py-3 font-medium">Founder</th>
                  <th className="px-5 py-3 font-medium">Reason</th>
                  <th className="px-5 py-3 font-medium">Outcome</th>
                  <th className="px-5 py-3 font-medium">By</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-neutral-100">
                {recent.map((d) => (
                  <tr key={d.id}>
                    <td className="px-5 py-3 font-mono text-xs">{d.save?.receipt_number}</td>
                    <td className="px-5 py-3 text-neutral-700">{d.accountName ?? d.account_id}</td>
                    <td className="px-5 py-3 text-neutral-700">{DISPUTE_CATEGORY_LABELS[d.category]}</td>
                    <td className="px-5 py-3 capitalize text-neutral-700">
                      {d.status} {d.resolution === "auto" ? "(auto)" : ""}
                    </td>
                    <td className="px-5 py-3 text-xs text-neutral-500">{d.resolved_by}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      </main>
    </div>
  );
}

function OpenDispute({ d }: { d: AdminDispute }) {
  const s = d.save;
  const evidence = d.evidence as EvidenceReport | null;
  return (
    <article className="rounded-xl border border-neutral-200 bg-white p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="font-mono text-sm font-semibold text-ink">{s?.receipt_number}</p>
          <p className="text-sm text-neutral-600">
            {d.accountName ?? d.account_id} · {s ? saveSummary(s) : ""} · fee {formatCents(Number(s?.fee_cents ?? 0))} on hold
          </p>
          {s?.type === "cancel" ? <p className="text-xs text-neutral-500">Offer: {describeOfferRecord(s.offer)}</p> : null}
          <p className="text-xs text-neutral-500">
            Customer {s?.customer_email ?? ""} <span className="font-mono">{s?.stripe_customer_id}</span>
            {s?.stripe_subscription_id ? <span className="font-mono"> · {s.stripe_subscription_id}</span> : null}
            {s?.stripe_invoice_id ? <span className="font-mono"> · {s.stripe_invoice_id}</span> : null}
          </p>
        </div>
        <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800">{DISPUTE_CATEGORY_LABELS[d.category]}</span>
      </div>
      {d.note ? <p className="mt-3 rounded-lg bg-neutral-50 px-3 py-2 text-sm text-neutral-700">“{d.note}”</p> : null}
      <div className="mt-3 text-xs text-neutral-600">
        <p className="font-medium text-neutral-700">Automatic checks</p>
        {evidence?.error ? <p className="text-amber-700">{evidence.error}</p> : null}
        {(evidence?.checks ?? []).map((c) => (
          <p key={c.invoice} className="font-mono">
            {c.invoice}: {c.paid ? "paid" : "NOT paid"}, refunded {formatCents(c.refunded_cents)}, subscription {c.subscription_matches ? "✓" : "✗"}, customer{" "}
            {c.customer_matches ? "✓" : "✗"}
          </p>
        ))}
        {(evidence?.failed ?? []).map((f) => (
          <p key={f}>{EVIDENCE_LABELS[f as EvidenceFailure]}</p>
        ))}
      </div>
      <form action={`/api/admin/disputes/${d.id}`} method="post" className="mt-4 space-y-3">
        <label htmlFor={`note-${d.id}`} className="block text-sm font-medium text-ink">
          Note to the founder
        </label>
        <textarea
          id={`note-${d.id}`}
          name="note"
          rows={2}
          maxLength={2000}
          className="w-full rounded-lg border border-neutral-300 px-3 py-2 text-sm focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand"
        />
        <div className="flex gap-3">
          <button name="decision" value="accept" className="rounded-lg bg-brand px-4 py-2 text-sm font-semibold text-white hover:bg-brand-dark">
            Accept · reverse fees
          </button>
          <button name="decision" value="reject" className="rounded-lg border border-neutral-300 bg-white px-4 py-2 text-sm font-medium text-neutral-700 hover:border-neutral-400 hover:text-ink">
            Reject · fee stands
          </button>
        </div>
      </form>
    </article>
  );
}
