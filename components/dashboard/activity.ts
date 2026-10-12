/**
 * The overview's activity feed: recent saves, cancel attempts and failed /
 * recovered payments merged into one timeline. Pure functions, shared by the
 * server render and the client's live refresh.
 */

export type ActivityKind = "save" | "pending" | "cancel" | "session" | "failed" | "recovery";

export type ActivityItem = {
  id: string;
  kind: ActivityKind;
  title: string;
  detail: string;
  amountCents: number | null;
  currency: string;
  /** "/mo" for recurring amounts. */
  per: "" | "/mo";
  at: string;
};

export const SAVE_COLUMNS = "id, type, status, stripe_customer_id, saved_mrr_cents, currency, receipt_number, created_at, verified_at";
export const SESSION_COLUMNS = "id, status, reason, reason_label, stripe_customer_id, mrr_at_start_cents, started_at";
export const CASE_COLUMNS =
  "id, status, customer_name, customer_email, stripe_customer_id, amount_due_cents, recovered_amount_cents, recovered_via, currency, opened_at, recovered_at";

export type SaveActivityRow = {
  id: string;
  type: "cancel" | "dunning";
  status: string;
  stripe_customer_id: string;
  saved_mrr_cents: number | string;
  currency: string;
  receipt_number: string;
  created_at: string;
  verified_at: string | null;
};
export type SessionActivityRow = {
  id: string;
  status: string;
  reason: string | null;
  reason_label: string | null;
  stripe_customer_id: string;
  mrr_at_start_cents: number | string | null;
  started_at: string;
};
export type CaseActivityRow = {
  id: string;
  status: string;
  customer_name: string | null;
  customer_email: string | null;
  stripe_customer_id: string;
  amount_due_cents: number | string;
  recovered_amount_cents: number | string | null;
  recovered_via: string | null;
  currency: string;
  opened_at: string;
  recovered_at: string | null;
};

const short = (id: string) => (id.length > 14 ? `${id.slice(0, 8)}…${id.slice(-4)}` : id);

export function buildActivity(
  saves: readonly SaveActivityRow[],
  sessions: readonly SessionActivityRow[],
  cases: readonly CaseActivityRow[],
  limit = 20,
): ActivityItem[] {
  const items: ActivityItem[] = [];

  for (const s of saves) {
    if (s.type !== "cancel") continue; // dunning saves show up as recovered cases
    const verified = s.status === "verified";
    items.push({
      id: `save-${s.id}-${s.status}`,
      kind: verified ? "save" : s.status === "pending" ? "pending" : "cancel",
      title: verified ? "Customer saved" : s.status === "pending" ? "Offer accepted" : `Save ${s.status.replace(/_/g, " ")}`,
      detail: verified ? `${s.receipt_number} · verified in Stripe` : `${short(s.stripe_customer_id)} · waiting for the next invoice`,
      amountCents: Number(s.saved_mrr_cents),
      currency: s.currency,
      per: "/mo",
      at: (verified ? s.verified_at : null) ?? s.created_at,
    });
  }

  for (const c of sessions) {
    if (c.status === "offer_accepted") continue; // the save row tells that story
    const reason = c.reason_label ?? c.reason;
    items.push({
      id: `session-${c.id}-${c.status}`,
      kind: c.status === "canceled" ? "cancel" : "session",
      title: c.status === "canceled" ? "Customer cancelled" : c.status === "abandoned" ? "Closed the cancel flow" : "Opened the cancel flow",
      detail: [short(c.stripe_customer_id), reason].filter(Boolean).join(" · "),
      amountCents: c.mrr_at_start_cents === null ? null : Number(c.mrr_at_start_cents),
      currency: "usd",
      per: "/mo",
      at: c.started_at,
    });
  }

  for (const d of cases) {
    const who = d.customer_name ?? d.customer_email ?? short(d.stripe_customer_id);
    if (d.status === "recovered") {
      const viaUnquit = d.recovered_via === "update_link" || d.recovered_via === "unquit_retry";
      items.push({
        id: `case-${d.id}-recovered`,
        kind: "recovery",
        title: viaUnquit ? "Payment recovered by unquit" : "Payment recovered",
        detail: `${who} · ${d.recovered_via === "update_link" ? "card-update link" : d.recovered_via === "unquit_retry" ? "unquit retry" : "Stripe retry"}`,
        amountCents: Number(d.recovered_amount_cents ?? d.amount_due_cents),
        currency: d.currency,
        per: "",
        at: d.recovered_at ?? d.opened_at,
      });
    } else {
      items.push({
        id: `case-${d.id}-${d.status}`,
        kind: "failed",
        title: d.status === "open" ? "Payment failed" : d.status === "failed" ? "Payment lost" : "Failed payment closed",
        detail: who,
        amountCents: Number(d.amount_due_cents),
        currency: d.currency,
        per: "",
        at: d.opened_at,
      });
    }
  }

  return items.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0)).slice(0, limit);
}

/** "just now", "5m ago", "3h ago", "2d ago", then a date. */
export function timeAgo(iso: string, now = Date.now()): string {
  const diff = Math.max(0, now - new Date(iso).getTime());
  const m = Math.floor(diff / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}
