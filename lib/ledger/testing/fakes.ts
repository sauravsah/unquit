/**
 * In-memory fakes for the ledger and billing tests. They keep the database's
 * guarantees:
 *   * fee lines are unique per (save, month) and (save, invoice)
 *   * one open dispute per save; one billing period per (account, month)
 *   * verifySave / markLost / markEnded / casClawedBack / resolveDispute /
 *     lockPeriod are compare-and-set
 *   * save_events dedupe on dedupe_key; invoice_reversals upsert on source_key
 * and a fake platform Stripe that replays idempotency keys.
 */
import type { BillingAccount, BillingRepo, BillingStripe, InvoiceSummary, PeriodRow } from "@/lib/billing/service";
import type { EvidenceStripe, FounderMailer, InvoiceEvidence } from "../disputes";
import type { RenderedEmail } from "../emails";
import type {
  ClawbackRow,
  DisputeRow,
  FeeLineRow,
  LedgerAccount,
  LedgerRepo,
  ReversalRow,
  SaveEventInput,
  SaveRow,
} from "../types";

let counter = 0;
export const uuid = () => `00000000-0000-4000-9000-${String(++counter).padStart(12, "0")}`;
let receiptSeq = 1000;

type SessionRow = { id: string; account_id: string; status: string; started_at: string };

export function fakeLedger(options: { clock?: () => Date } = {}) {
  const clock = options.clock ?? (() => new Date());
  const accounts = new Map<string, LedgerAccount & Omit<BillingAccount, "id" | "name"> & { connected_at: string | null; connected: boolean }>();
  const saves = new Map<string, SaveRow>();
  const lines: FeeLineRow[] = [];
  const reversals: ReversalRow[] = [];
  const clawbacks: ClawbackRow[] = [];
  const events: (SaveEventInput & { id: string })[] = [];
  const disputes: DisputeRow[] = [];
  const sessions: SessionRow[] = [];
  const periods: PeriodRow[] = [];

  const copy = <T>(x: T): T => ({ ...(x as object) }) as T;

  const repo: LedgerRepo = {
    async getAccount(id) {
      const a = accounts.get(id);
      return a ? { id: a.id, name: a.name, stripe_account_id: a.stripe_account_id, owner_user_id: a.owner_user_id } : null;
    },
    async getSave(id) {
      const s = saves.get(id);
      return s ? copy(s) : null;
    },
    async savesForSubscription(accountId, subId, statuses) {
      return [...saves.values()]
        .filter((s) => s.account_id === accountId && s.stripe_subscription_id === subId && statuses.includes(s.status))
        .sort((a, b) => a.created_at.localeCompare(b.created_at))
        .map(copy);
    },
    async pendingSavesCreatedBefore(cutoff, limit) {
      return [...saves.values()].filter((s) => s.status === "pending" && s.created_at < cutoff).slice(0, limit).map(copy);
    },
    async verifySave(id, f) {
      const s = saves.get(id);
      if (!s || s.status !== "pending") return false;
      Object.assign(s, { status: "verified", verified_at: f.verifiedAt, stripe_invoice_id: f.invoiceId });
      if (f.customerEmail) s.customer_email = f.customerEmail;
      return true;
    },
    async markLost(id, reason, at) {
      const s = saves.get(id);
      if (!s || s.status !== "pending") return false;
      Object.assign(s, { status: "lost", lost_reason: reason, lost_at: at });
      return true;
    },
    async markEnded(id, reason, at) {
      const s = saves.get(id);
      if (!s || s.ended_at) return false;
      Object.assign(s, { ended_at: at, end_reason: reason });
      return true;
    },
    async setSaveStatus(id, from, to, extra = {}) {
      const s = saves.get(id);
      if (!s || !from.includes(s.status)) return false;
      Object.assign(s, { status: to, ...extra });
      return true;
    },
    async setSaveFee(id, fee) {
      const s = saves.get(id);
      if (s) s.fee_cents = fee;
    },
    async savesNeedingReceipt(since, limit, accountId) {
      return [...saves.values()]
        .filter(
          (s) =>
            (s.status === "verified" || s.status === "disputed") &&
            !s.receipt_emailed_at &&
            !!s.verified_at &&
            s.verified_at >= since &&
            (!accountId || s.account_id === accountId),
        )
        .slice(0, limit)
        .map(copy);
    },
    async claimReceiptEmail(id, at) {
      const s = saves.get(id);
      if (!s || s.receipt_emailed_at) return false;
      s.receipt_emailed_at = at;
      return true;
    },
    async releaseReceiptEmail(id, at) {
      const s = saves.get(id);
      if (s && s.receipt_emailed_at === at) s.receipt_emailed_at = null;
    },
    async linesForSave(saveId) {
      return lines.filter((l) => l.save_id === saveId).sort((a, b) => a.month_index - b.month_index).map(copy);
    },
    async linesForInvoice(accountId, invoiceId) {
      return lines.filter((l) => l.account_id === accountId && l.stripe_invoice_id === invoiceId).map(copy);
    },
    async insertFeeLine(row) {
      if (lines.some((l) => l.save_id === row.save_id && (l.month_index === row.month_index || l.stripe_invoice_id === row.stripe_invoice_id))) {
        return null;
      }
      const line: FeeLineRow = {
        id: uuid(),
        created_at: clock().toISOString(),
        clawed_back_cents: 0,
        status: "earned",
        held_stripe_dispute_id: null,
        billing_period_id: null,
        billed_at: null,
        overlap_save_id: null,
        overlap_reduced_at: null,
        ...row,
      };
      lines.push(line);
      return copy(line);
    },
    async reduceLineForOverlap(id, f) {
      const l = lines.find((x) => x.id === id);
      if (!l || l.overlap_save_id) return false;
      if (f.amountCents < 0 || f.amountCents > l.amount_cents) throw new Error("overlap may only lower a fee");
      l.amount_cents = f.amountCents;
      l.clawed_back_cents = Math.min(l.clawed_back_cents, f.amountCents);
      l.overlap_save_id = f.overlapSaveId;
      l.overlap_reduced_at = f.at;
      return true;
    },
    async casClawedBack(id, from, to, full) {
      const l = lines.find((x) => x.id === id);
      if (!l || l.clawed_back_cents !== from) return false;
      if (to < 0 || to > l.amount_cents) throw new Error("save_fee_lines_clawback_range");
      l.clawed_back_cents = to;
      if (full) l.status = "clawed_back";
      return true;
    },
    async holdLinesForInvoice(accountId, invoiceId, disputeId) {
      const hit = lines.filter((l) => l.account_id === accountId && l.stripe_invoice_id === invoiceId);
      for (const l of hit) l.held_stripe_dispute_id = disputeId;
      return hit.map(copy);
    },
    async releaseStripeHold(accountId, disputeId) {
      const hit = lines.filter((l) => l.account_id === accountId && l.held_stripe_dispute_id === disputeId);
      for (const l of hit) l.held_stripe_dispute_id = null;
      return hit.map(copy);
    },
    async setFounderHold(saveId, disputeId) {
      for (const l of lines) if (l.save_id === saveId) l.held_founder_dispute_id = disputeId;
    },
    async upsertReversal(row) {
      const existing = reversals.find((r) => r.account_id === row.account_id && r.source_key === row.source_key);
      if (existing) Object.assign(existing, row);
      else reversals.push({ ...row });
    },
    async reversalsForInvoice(accountId, invoiceId) {
      return reversals.filter((r) => r.account_id === accountId && r.stripe_invoice_id === invoiceId).map(copy);
    },
    async insertClawback(row) {
      if (row.amount_cents <= 0) throw new Error("fee_clawbacks_amount_cents_check");
      clawbacks.push({ id: uuid(), created_at: clock().toISOString(), ...row });
    },
    async clawbacksForSave(saveId) {
      return clawbacks.filter((c) => c.save_id === saveId).map(copy);
    },
    async addEvent(e) {
      if (e.dedupeKey && events.some((x) => x.dedupeKey === e.dedupeKey)) return;
      events.push({ ...e, id: uuid() });
    },
    async openDisputeForSave(saveId) {
      const d = disputes.find((x) => x.save_id === saveId && x.status === "open");
      return d ? copy(d) : null;
    },
    async insertDispute(row) {
      if (disputes.some((d) => d.save_id === row.save_id && d.status === "open")) return null;
      const d: DisputeRow = {
        id: uuid(),
        status: "open",
        resolution: null,
        resolution_note: null,
        resolved_by: null,
        evidence: null,
        resolved_at: null,
        founder_notified_at: null,
        ...row,
      };
      disputes.push(d);
      return copy(d);
    },
    async getDispute(id) {
      const d = disputes.find((x) => x.id === id);
      return d ? copy(d) : null;
    },
    async setDisputeEvidence(id, evidence) {
      const d = disputes.find((x) => x.id === id);
      if (d) d.evidence = evidence;
    },
    async resolveDispute(id, f) {
      const d = disputes.find((x) => x.id === id);
      if (!d || d.status !== "open") return false;
      Object.assign(d, { status: f.status, resolution: f.resolution, resolution_note: f.note, resolved_by: f.resolvedBy, resolved_at: f.at });
      return true;
    },
    async markDisputeNotified(id, at) {
      const d = disputes.find((x) => x.id === id);
      if (d) d.founder_notified_at = at;
    },
    async abandonSessionsStartedBefore(cutoff) {
      let n = 0;
      for (const s of sessions) {
        if (s.status === "started" && s.started_at < cutoff) {
          s.status = "abandoned";
          n++;
        }
      }
      return n;
    },
  };

  const billing: BillingRepo = {
    async accountsToBill(month) {
      const [y, m] = month.split("-").map(Number) as [number, number];
      const next = new Date(Date.UTC(y, m, 1)).toISOString();
      const ids = new Set<string>();
      for (const a of accounts.values()) if (a.connected && a.connected_at && a.connected_at < next) ids.add(a.id);
      for (const l of lines) if (!l.billing_period_id && l.status === "earned" && l.billing_month <= month) ids.add(l.account_id);
      return [...ids];
    },
    async getBillingAccount(id) {
      const a = accounts.get(id);
      return a ? { id: a.id, name: a.name, email: a.email, platform_customer_id: a.platform_customer_id, billing_pm_status: a.billing_pm_status } : null;
    },
    async setPlatformCustomer(id, customerId) {
      const a = accounts.get(id)!;
      a.platform_customer_id = a.platform_customer_id ?? customerId;
      return a.platform_customer_id;
    },
    async getPeriod(accountId, month) {
      const p = periods.find((x) => x.account_id === accountId && x.period_month === month);
      return p ? copy(p) : null;
    },
    async ensurePeriod(accountId, month, cap) {
      let p = periods.find((x) => x.account_id === accountId && x.period_month === month);
      if (!p) {
        p = {
          id: uuid(),
          account_id: accountId,
          period_month: month,
          status: "building",
          cancel_fees_cents: 0,
          cancel_lines_count: 0,
          dunning_fees_cents: 0,
          dunning_lines_count: 0,
          clawed_back_cents: 0,
          gross_cents: 0,
          cap_cents: cap,
          cap_discount_cents: 0,
          capped_cents: 0,
          credit_applied_cents: 0,
          total_cents: 0,
          stripe_invoice_id: null,
          hosted_invoice_url: null,
          invoice_pdf_url: null,
          invoice_status: null,
          attempts: 0,
          locked_at: null,
          error: null,
          computed_at: null,
          finalized_at: null,
          created_at: clock().toISOString(),
          carried_in_cents: 0,
          amount_due_cents: 0,
          carried_to_period_id: null,
          payment_status: null,
        };
        periods.push(p);
      }
      return copy(p);
    },
    async lockPeriod(id, at, staleBefore) {
      const p = periods.find((x) => x.id === id);
      if (!p || !["building", "failed"].includes(p.status)) return null;
      if (p.locked_at && p.locked_at >= staleBefore) return null;
      Object.assign(p, { locked_at: at, attempts: p.attempts + 1, status: "building" });
      return copy(p);
    },
    async assignLines(accountId, periodId, month, at) {
      for (const l of lines) {
        if (
          l.account_id === accountId &&
          !l.billing_period_id &&
          l.status === "earned" &&
          l.billing_month <= month &&
          !l.held_stripe_dispute_id &&
          !l.held_founder_dispute_id
        ) {
          Object.assign(l, { billing_period_id: periodId, status: "billed", billed_at: at });
        }
      }
    },
    async linesForPeriod(periodId) {
      return lines
        .filter((l) => l.billing_period_id === periodId)
        .map((l) => ({
          id: l.id,
          saveId: l.save_id,
          kind: saves.get(l.save_id)?.type ?? "cancel",
          amountCents: l.amount_cents,
          clawedBackCents: l.clawed_back_cents,
        }));
    },
    async closedPeriods(accountId, except) {
      return periods.filter((p) => p.account_id === accountId && p.id !== except && (p.status === "invoiced" || p.status === "closed" || p.status === "zero")).map(copy);
    },
    async updatePeriod(id, fields) {
      const p = periods.find((x) => x.id === id)!;
      const next = { ...p, ...fields };
      // the table's CHECK constraints
      if (next.capped_cents !== next.gross_cents - next.cap_discount_cents || next.capped_cents > next.cap_cents) {
        throw new Error("billing_periods_cap_maths");
      }
      if (next.total_cents !== next.capped_cents - next.credit_applied_cents) throw new Error("billing_periods_total_maths");
      if (next.status === "invoiced" && !next.stripe_invoice_id) throw new Error("billing_periods_invoiced_has_invoice");
      Object.assign(p, fields);
    },
  };

  return {
    repo,
    billing,
    accounts,
    saves,
    lines,
    reversals,
    clawbacks,
    events,
    disputes,
    sessions,
    periods,
    addAccount(partial: Partial<LedgerAccount & BillingAccount & { connected_at: string | null; connected: boolean }> = {}) {
      const a = {
        id: partial.id ?? "acc_1",
        name: "Acme",
        stripe_account_id: "acct_1",
        owner_user_id: "user_1",
        email: "founder@acme.test",
        platform_customer_id: null as string | null,
        billing_pm_status: "none" as "none" | "active",
        connected_at: "2026-01-01T00:00:00.000Z" as string | null,
        connected: true,
        ...partial,
      };
      accounts.set(a.id, a);
      return a;
    },
    addSave(partial: Partial<SaveRow> = {}): SaveRow {
      const s: SaveRow = {
        id: uuid(),
        account_id: "acc_1",
        type: "cancel",
        status: "pending",
        cancel_session_id: uuid(),
        dunning_case_id: null,
        stripe_customer_id: "cus_1",
        stripe_subscription_id: "sub_1",
        stripe_invoice_id: null,
        customer_email: null,
        offer: { type: "discount", percent_off: 30, months: 3 },
        saved_mrr_cents: 10_000,
        recovered_amount_cents: 0,
        currency: "usd",
        fee_cents: 0,
        attributed_via: null,
        verified_at: null,
        clawed_back_at: null,
        lost_at: null,
        lost_reason: null,
        ended_at: null,
        end_reason: null,
        receipt_number: `UQ-${String(++receiptSeq).padStart(7, "0")}`,
        receipt_emailed_at: null,
        created_at: clock().toISOString(),
        ...partial,
      };
      saves.set(s.id, s);
      return copy(s);
    },
    addLine(partial: Partial<FeeLineRow> & { save_id: string }): FeeLineRow {
      const l: FeeLineRow = {
        id: uuid(),
        account_id: "acc_1",
        month_index: 1,
        billing_month: "2026-09-01",
        stripe_invoice_id: `in_${counter}`,
        amount_cents: 2_000,
        invoice_amount_paid_cents: 10_000,
        clawed_back_cents: 0,
        status: "earned",
        held_stripe_dispute_id: null,
        held_founder_dispute_id: null,
        billing_period_id: null,
        billed_at: null,
        created_at: clock().toISOString(),
        ...partial,
      };
      lines.push(l);
      return copy(l);
    },
    addSession(partial: Partial<SessionRow> = {}) {
      const s = { id: uuid(), account_id: "acc_1", status: "started", started_at: clock().toISOString(), ...partial };
      sessions.push(s);
      return s;
    },
    eventsFor(saveId: string) {
      return events.filter((e) => e.saveId === saveId).map((e) => e.kind);
    },
  };
}

export function fakeEvidence(byInvoice: Record<string, InvoiceEvidence | null> = {}) {
  const calls: string[] = [];
  let throws = false;
  const stripe: EvidenceStripe = {
    async getInvoiceEvidence(_acct, id) {
      calls.push(id);
      if (throws) throw new Error("Stripe is down");
      return id in byInvoice ? byInvoice[id]! : null;
    },
  };
  return { stripe, byInvoice, calls, fail: () => void (throws = true) };
}

export function fakeMailer() {
  const founder: (RenderedEmail & { idempotencyKey: string; accountId: string })[] = [];
  const admins: (RenderedEmail & { idempotencyKey: string })[] = [];
  const seen = new Set<string>();
  let failures = 0;
  const mailer: FounderMailer = {
    async toFounder(accountId, email) {
      if (failures > 0) {
        failures--;
        throw new Error("Resend is down");
      }
      if (seen.has(email.idempotencyKey)) return true;
      seen.add(email.idempotencyKey);
      founder.push({ ...email, accountId });
      return true;
    },
    async toAdmins(email) {
      admins.push(email);
    },
  };
  return { mailer, founder, admins, failNext: (n = 1) => void (failures = n) };
}

/** unquit's own (platform) Stripe account: customers, draft invoices, items. */
export function fakeBillingStripe() {
  type FakeInvoice = InvoiceSummary & {
    customerId: string;
    collection: string;
    items: { amountCents: number; description: string; key: string }[];
    footer: string;
    metadata: Record<string, string>;
    deleted: boolean;
  };
  const customers: { id: string; accountId: string; email: string | null }[] = [];
  const invoices: FakeInvoice[] = [];
  const replay = new Map<string, unknown>();
  const failures: { at: "createInvoice" | "addInvoiceItem" | "finalizeInvoice"; times: number }[] = [];
  const shouldFail = (at: (typeof failures)[number]["at"]) => {
    const f = failures.find((x) => x.at === at && x.times > 0);
    if (!f) return false;
    f.times--;
    return true;
  };
  const once = <T>(key: string, run: () => T): T => {
    if (replay.has(key)) return replay.get(key) as T;
    const result = run();
    replay.set(key, result);
    return result;
  };
  const total = (inv: FakeInvoice) => inv.items.reduce((a, i) => a + i.amountCents, 0);

  const stripe: BillingStripe = {
    async createCustomer(input, key) {
      return once(key, () => {
        const id = `cus_platform_${customers.length + 1}`;
        customers.push({ id, accountId: input.accountId, email: input.email });
        return id;
      });
    },
    async createInvoice(input, key) {
      if (shouldFail("createInvoice")) throw new Error("Stripe 500 on create");
      return once(key, () => {
        const inv: FakeInvoice = {
          id: `in_platform_${invoices.length + 1}`,
          status: "draft",
          hostedInvoiceUrl: null,
          invoicePdf: null,
          totalCents: 0,
          customerId: input.customerId,
          collection: input.collection,
          items: [],
          footer: input.footer,
          metadata: input.metadata,
          deleted: false,
        };
        invoices.push(inv);
        return { id: inv.id };
      });
    },
    async addInvoiceItem(input, key) {
      if (shouldFail("addInvoiceItem")) throw new Error("Stripe 500 on item");
      once(key, () => {
        const inv = invoices.find((i) => i.id === input.invoiceId)!;
        if (inv.status !== "draft" || inv.deleted) throw new Error("invoice is not a draft");
        inv.items.push({ amountCents: input.amountCents, description: input.description, key: input.metadata.line ?? "" });
        inv.totalCents = total(inv);
      });
    },
    async finalizeInvoice(id, key) {
      if (shouldFail("finalizeInvoice")) throw new Error("Stripe 500 on finalize");
      return once(key, () => {
        const inv = invoices.find((i) => i.id === id)!;
        if (inv.status !== "draft") throw new Error("already finalized");
        if (total(inv) < 0) throw new Error("negative invoice");
        Object.assign(inv, {
          status: "open",
          totalCents: total(inv),
          hostedInvoiceUrl: `https://invoice.stripe.test/${inv.id}`,
          invoicePdf: `https://pay.stripe.test/${inv.id}.pdf`,
        });
        return { id: inv.id, status: inv.status, hostedInvoiceUrl: inv.hostedInvoiceUrl, invoicePdf: inv.invoicePdf, totalCents: inv.totalCents };
      });
    },
    async getInvoice(id) {
      const inv = invoices.find((i) => i.id === id && !i.deleted);
      return inv ? { id: inv.id, status: inv.status, hostedInvoiceUrl: inv.hostedInvoiceUrl, invoicePdf: inv.invoicePdf, totalCents: total(inv) } : null;
    },
    async deleteDraftInvoice(id) {
      const inv = invoices.find((i) => i.id === id)!;
      if (inv.status !== "draft") throw new Error("only drafts can be deleted");
      inv.deleted = true;
    },
  };
  return {
    stripe,
    customers,
    invoices,
    live: () => invoices.filter((i) => !i.deleted && i.status !== "draft"),
    failOn: (at: (typeof failures)[number]["at"], times = 1) => failures.push({ at, times }),
  };
}
