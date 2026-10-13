/**
 * Everything one save's receipt shows (/dashboard/saves/<receipt_number>),
 * and the status timeline built from it. The timeline maths is pure so it is
 * unit-tested; the loader reads with the founder's own RLS-bound client.
 */
import { attempt, queryOne, type Db } from "@/lib/db/core";
import { describeOfferRecord } from "@/lib/flows/describe";
import { describeDeclineCode } from "@/lib/dunning/declines";
import { formatCents } from "@/lib/pricing";
import { pendingDeadline } from "@/lib/saves/rules";
import { DISPUTE_CATEGORY_LABELS } from "./emails";
import { isHeld, monthLabel, monthSlug, netCents } from "./fees";
import {
  DISPUTE_COLUMNS,
  FEE_LINE_COLUMNS,
  SAVE_COLUMNS,
  type ClawbackRow,
  type DisputeRow,
  type FeeLineRow,
  type SaveEventRow,
  type SaveRow,
} from "./types";

export type ReceiptSession = {
  reason: string | null;
  reason_label: string | null;
  reason_detail: string | null;
  offer_accepted_at: string | null;
  started_at: string;
};

export type ReceiptCase = {
  stripe_invoice_id: string;
  customer_email: string | null;
  customer_name: string | null;
  invoice_number: string | null;
  decline_code: string | null;
  decline_category: string | null;
  opened_at: string;
  recovered_at: string | null;
  recovered_via: string | null;
};

export type ReceiptPeriod = { id: string; period_month: string; status: string; hosted_invoice_url: string | null };

export type ReceiptData = {
  save: SaveRow;
  session: ReceiptSession | null;
  dunningCase: ReceiptCase | null;
  lines: FeeLineRow[];
  clawbacks: ClawbackRow[];
  events: SaveEventRow[];
  disputes: DisputeRow[];
  periods: ReceiptPeriod[];
  stripeLivemode: boolean | null;
};

export type TimelineTone = "done" | "pending" | "bad" | "neutral";
export type TimelineItem = { at: string | null; title: string; detail?: string; tone: TimelineTone };

const ATTRIBUTION_LABEL: Record<string, string> = {
  update_link: "the customer updated their card on unquit's page",
  unquit_retry: "unquit retried the card after the customer opened the email link",
};

const LOST_LABEL: Record<string, string> = {
  expired: "No qualifying paid invoice arrived in time, so this save never counted.",
  superseded: "A newer cancel session on the same subscription replaced it.",
  customer_canceled: "The customer cancelled the subscription before paying again.",
};

/** Stripe dashboard link for an object on the founder's account (test mode aware). */
export function stripeDashboardUrl(kind: "invoices" | "customers" | "subscriptions", id: string, livemode: boolean | null): string {
  return `https://dashboard.stripe.com/${livemode === false ? "test/" : ""}${kind}/${encodeURIComponent(id)}`;
}

export function verifyingInvoiceIds(data: Pick<ReceiptData, "save" | "lines">): string[] {
  return [...new Set([data.save.stripe_invoice_id, ...data.lines.map((l) => l.stripe_invoice_id)].filter((x): x is string => !!x))];
}

const n = (v: unknown) => Number(v ?? 0);

/** The receipt's status timeline: how the save was won, then everything since. */
export function buildTimeline(data: ReceiptData, verifyWindowDays = 45): TimelineItem[] {
  const { save, session, dunningCase } = data;
  const items: TimelineItem[] = [];
  const events = [...data.events].sort((a, b) => a.occurred_at.localeCompare(b.occurred_at));
  const firstLine = data.lines.find((l) => l.month_index === 1) ?? null;

  if (save.type === "cancel") {
    items.push({
      at: session?.offer_accepted_at ?? save.created_at,
      title: "Offer accepted",
      detail: `${describeOfferRecord(save.offer)}${session?.reason_label ? ` · reason: ${session.reason_label}` : ""}`,
      tone: "done",
    });
    const paidEvent = events.find((e) => e.kind === "invoice_paid");
    if (save.verified_at) {
      items.push({
        at: paidEvent?.occurred_at ?? save.verified_at,
        title: "Invoice paid",
        detail: `${save.stripe_invoice_id ?? "invoice"} · ${formatCents(n(firstLine?.invoice_amount_paid_cents ?? paidEvent?.detail.amount_paid_cents), save.currency)}`,
        tone: "done",
      });
      items.push({
        at: save.verified_at,
        title: "Verified",
        detail: `Month 1 fee: ${formatCents(n(firstLine?.amount_cents))}`,
        tone: "done",
      });
    } else if (save.status === "pending") {
      items.push({
        at: null,
        title: "Waiting for the next paid invoice",
        detail: `Nothing is charged until it's paid. Expires ${pendingDeadline(save, verifyWindowDays).toLocaleDateString("en-US", {
          month: "short",
          day: "numeric",
          year: "numeric",
          timeZone: "UTC",
        })} if no paid invoice arrives.`,
        tone: "pending",
      });
    }
  } else {
    items.push({
      at: dunningCase?.opened_at ?? save.created_at,
      title: "Payment failed",
      detail: dunningCase?.decline_code ? describeDeclineCode(dunningCase.decline_code) : undefined,
      tone: "neutral",
    });
    items.push({
      at: dunningCase?.recovered_at ?? save.verified_at,
      title: "Invoice paid",
      detail: `${save.stripe_invoice_id ?? ""} · ${ATTRIBUTION_LABEL[save.attributed_via ?? ""] ?? "recovered by unquit"}`,
      tone: "done",
    });
    items.push({ at: save.verified_at, title: "Verified", detail: `Fee: ${formatCents(n(firstLine?.amount_cents ?? save.fee_cents))} (10%)`, tone: "done" });
  }

  for (const e of events) {
    const d = e.detail ?? {};
    switch (e.kind) {
      case "fee_line":
        items.push({ at: e.occurred_at, title: `Month ${n(d.month_index)} paid`, detail: `${String(d.invoice ?? "")} · fee ${formatCents(n(d.fee_cents))}`, tone: "done" });
        break;
      case "refund":
      case "credit_note":
        items.push({
          at: e.occurred_at,
          title: e.kind === "refund" ? "Customer refunded" : "Credit note issued",
          detail: `${formatCents(n(d.clawed_back_cents))} of the month ${n(d.month_index)} fee clawed back`,
          tone: "bad",
        });
        break;
      case "stripe_dispute_opened":
        items.push({ at: e.occurred_at, title: "Chargeback opened", detail: "The fee for that invoice is on hold until Stripe settles it.", tone: "pending" });
        break;
      case "stripe_dispute_won":
        items.push({ at: e.occurred_at, title: "Chargeback won", detail: "The hold is lifted.", tone: "done" });
        break;
      case "stripe_dispute_lost":
        items.push({ at: e.occurred_at, title: "Chargeback lost", detail: `${formatCents(n(d.clawed_back_cents))} of the fee reversed`, tone: "bad" });
        break;
      case "dispute_opened":
        items.push({
          at: e.occurred_at,
          title: "You disputed this save",
          detail: `${DISPUTE_CATEGORY_LABELS[(d.category as keyof typeof DISPUTE_CATEGORY_LABELS) ?? "other"] ?? "Other"}. Fees on hold.`,
          tone: "pending",
        });
        break;
      case "dispute_accepted":
        items.push({ at: e.occurred_at, title: d.resolution === "auto" ? "Dispute accepted automatically" : "Dispute accepted", detail: "All fees reversed.", tone: "bad" });
        break;
      case "dispute_rejected":
        items.push({ at: e.occurred_at, title: "Dispute reviewed: fee stands", detail: typeof d.note === "string" ? d.note : undefined, tone: "neutral" });
        break;
      case "lost":
        items.push({ at: e.occurred_at, title: "Lost", detail: LOST_LABEL[String(d.reason)] ?? undefined, tone: "bad" });
        break;
      case "ended":
        items.push({ at: e.occurred_at, title: "Subscription cancelled", detail: "No more fees. The months already paid stand.", tone: "neutral" });
        break;
      default:
        break;
    }
  }

  // Which statement billed each line.
  const periods = new Map(data.periods.map((p) => [p.id, p]));
  for (const line of data.lines) {
    const p = line.billing_period_id ? periods.get(line.billing_period_id) : undefined;
    if (p && line.billed_at) {
      items.push({ at: line.billed_at, title: `Billed on the ${monthLabel(p.period_month)} statement`, detail: `Month ${line.month_index}: ${formatCents(netCents(line))}`, tone: "neutral" });
    }
  }

  if (save.type === "cancel" && save.status !== "lost" && !save.ended_at && data.lines.length >= 3) {
    items.push({ at: null, title: "Free from now on", detail: "Three paid months have been billed. This customer costs nothing from here.", tone: "done" });
  }

  // Keep the three "how it was won" steps first, then the rest by time.
  const head = items.slice(0, save.type === "cancel" ? (save.verified_at ? 3 : save.status === "pending" ? 2 : 1) : 3);
  const tail = items.slice(head.length).sort((a, b) => (a.at ?? "9999").localeCompare(b.at ?? "9999"));
  return [...head, ...tail];
}

export type FeeLineView = {
  monthIndex: number;
  billingMonth: string;
  invoiceId: string | null;
  amountCents: number;
  clawedBackCents: number;
  netCents: number;
  held: boolean;
  holdReason: string | null;
  statement: { month: string; slug: string; url: string | null } | null;
};

export function feeLineViews(data: Pick<ReceiptData, "lines" | "periods">): FeeLineView[] {
  const periods = new Map(data.periods.map((p) => [p.id, p]));
  return data.lines.map((l) => {
    const p = l.billing_period_id ? periods.get(l.billing_period_id) : undefined;
    return {
      monthIndex: l.month_index,
      billingMonth: l.billing_month,
      invoiceId: l.stripe_invoice_id,
      amountCents: n(l.amount_cents),
      clawedBackCents: n(l.clawed_back_cents),
      netCents: netCents(l),
      held: isHeld(l),
      holdReason: l.held_stripe_dispute_id ? "Chargeback open" : l.held_founder_dispute_id ? "Your dispute is open" : null,
      statement: p ? { month: p.period_month, slug: monthSlug(p.period_month), url: p.hosted_invoice_url } : null,
    };
  });
}

/** Loads one receipt for the founder's account (null if it isn't theirs). Every query is scoped by account id. */
export async function loadReceipt(db: Db, accountId: string, receiptNumber: string): Promise<ReceiptData | null> {
  if (!/^UQ-\d{1,12}$/.test(receiptNumber)) return null;
  const what = "Loading receipt";
  const s = await attempt(what, () =>
    queryOne<SaveRow>(db, `select ${SAVE_COLUMNS} from saves where account_id = $1 and receipt_number = $2`, [accountId, receiptNumber]),
  );
  if (!s) return null;

  const [session, dunningCase, lineRows, clawbacks, events, disputes, account] = await Promise.all([
    s.cancel_session_id
      ? attempt(what, () =>
          queryOne<ReceiptSession>(
            db,
            "select reason, reason_label, reason_detail, offer_accepted_at, started_at from cancel_sessions where account_id = $1 and id = $2",
            [accountId, s.cancel_session_id],
          ),
        )
      : Promise.resolve(null),
    s.dunning_case_id
      ? attempt(what, () =>
          queryOne<ReceiptCase>(
            db,
            `select stripe_invoice_id, customer_email, customer_name, invoice_number, decline_code, decline_category, opened_at, recovered_at, recovered_via
               from dunning_cases where account_id = $1 and id = $2`,
            [accountId, s.dunning_case_id],
          ),
        )
      : Promise.resolve(null),
    attempt(what, () =>
      db.query<FeeLineRow>(`select ${FEE_LINE_COLUMNS} from save_fee_lines where account_id = $1 and save_id = $2 order by month_index asc`, [
        accountId,
        s.id,
      ]),
    ),
    attempt(what, () =>
      db.query<ClawbackRow>(
        `select id, account_id, save_id, fee_line_id, kind, source, amount_cents, created_at
           from fee_clawbacks where account_id = $1 and save_id = $2 order by created_at asc`,
        [accountId, s.id],
      ),
    ),
    attempt(what, () =>
      db.query<SaveEventRow>(
        "select id, save_id, kind, detail, occurred_at from save_events where account_id = $1 and save_id = $2 order by occurred_at asc",
        [accountId, s.id],
      ),
    ),
    attempt(what, () =>
      db.query<DisputeRow>(`select ${DISPUTE_COLUMNS} from disputes where account_id = $1 and save_id = $2 order by created_at desc`, [
        accountId,
        s.id,
      ]),
    ),
    attempt(what, () => queryOne<{ stripe_livemode: boolean | null }>(db, "select stripe_livemode from accounts where id = $1", [accountId])),
  ]);
  const periodIds = [...new Set(lineRows.map((l) => l.billing_period_id).filter((x): x is string => !!x))];
  const periods = periodIds.length
    ? await attempt(what, () =>
        db.query<ReceiptPeriod>("select id, period_month, status, hosted_invoice_url from billing_periods where account_id = $1 and id = any($2)", [
          accountId,
          periodIds,
        ]),
      )
    : [];

  return {
    save: s,
    session: session ?? null,
    dunningCase: dunningCase ?? null,
    lines: lineRows,
    clawbacks,
    events,
    disputes,
    periods,
    stripeLivemode: account?.stripe_livemode ?? null,
  };
}
