import { describe, expect, it } from "vitest";
import { fakeLedger } from "@/lib/ledger/testing/fakes";
import { decideNextFeeMonth, pendingDeadline } from "./rules";
import {
  abandonStaleSessions,
  endSavesForSubscription,
  expirePendingSaves,
  processPaidInvoice,
  supersedePendingSaves,
  verifyWindowDays,
  type PaidInvoiceEvent,
} from "./verify";

const DAY = 86_400_000;
const ACCEPTED = new Date("2026-08-10T12:00:00.000Z");
const unix = (iso: string) => Date.parse(iso) / 1000;

const paid = (id: string, createdIso: string, over: Partial<PaidInvoiceEvent> = {}): PaidInvoiceEvent => ({
  id,
  subscriptionId: "sub_1",
  amountPaidCents: 7_000,
  createdUnix: unix(createdIso),
  billingReason: "subscription_cycle",
  customerEmail: "jamie@example.com",
  paidAt: new Date(createdIso),
  ...over,
});

function setup() {
  const db = fakeLedger({ clock: () => ACCEPTED });
  db.addAccount();
  const save = db.addSave({ saved_mrr_cents: 7_000, created_at: ACCEPTED.toISOString() }); // $70/mo saved
  return { db, save };
}

describe("cancel saves earn 20% of saved MRR for the first 3 paid months, then nothing", () => {
  it("verifies on the first qualifying paid invoice and writes fee line 1", async () => {
    const { db, save } = setup();
    const result = await processPaidInvoice(db.repo, "acc_1", paid("in_m1", "2026-09-01T00:00:00Z"));
    expect(result.verified).toEqual([save.id]);
    expect(db.saves.get(save.id)).toMatchObject({
      status: "verified",
      stripe_invoice_id: "in_m1",
      customer_email: "jamie@example.com",
      fee_cents: 1_400,
      verified_at: "2026-09-01T00:00:00.000Z",
    });
    expect(db.lines).toEqual([
      expect.objectContaining({ save_id: save.id, month_index: 1, amount_cents: 1_400, billing_month: "2026-09-01", stripe_invoice_id: "in_m1", invoice_amount_paid_cents: 7_000 }),
    ]);
    expect(db.eventsFor(save.id)).toEqual(["invoice_paid", "verified"]);
  });

  it("adds months 2 and 3 on the next paid invoices, then the save is free forever", async () => {
    const { db, save } = setup();
    await processPaidInvoice(db.repo, "acc_1", paid("in_m1", "2026-09-01T00:00:00Z"));
    const m2 = await processPaidInvoice(db.repo, "acc_1", paid("in_m2", "2026-10-01T00:00:00Z"));
    const m3 = await processPaidInvoice(db.repo, "acc_1", paid("in_m3", "2026-11-01T00:00:00Z"));
    const m4 = await processPaidInvoice(db.repo, "acc_1", paid("in_m4", "2026-12-01T00:00:00Z"));
    const m5 = await processPaidInvoice(db.repo, "acc_1", paid("in_m5", "2027-01-01T00:00:00Z"));

    expect(m2.monthsAdded).toEqual([{ saveId: save.id, monthIndex: 2 }]);
    expect(m3.monthsAdded).toEqual([{ saveId: save.id, monthIndex: 3 }]);
    expect(m4.monthsAdded).toEqual([]);
    expect(m5.monthsAdded).toEqual([]);
    expect(m4.skipped[0]!.reason).toMatch(/free from now on/);
    expect(db.lines.map((l) => [l.month_index, l.billing_month, l.amount_cents])).toEqual([
      [1, "2026-09-01", 1_400],
      [2, "2026-10-01", 1_400],
      [3, "2026-11-01", 1_400],
    ]);
    expect(db.saves.get(save.id)!.fee_cents).toBe(4_200); // 60% of one month's MRR, never more
  });

  it("is idempotent: a re-delivered invoice.paid adds nothing", async () => {
    const { db } = setup();
    await processPaidInvoice(db.repo, "acc_1", paid("in_m1", "2026-09-01T00:00:00Z"));
    await processPaidInvoice(db.repo, "acc_1", paid("in_m1", "2026-09-01T00:00:00Z"));
    await processPaidInvoice(db.repo, "acc_1", paid("in_m2", "2026-10-01T00:00:00Z"));
    await processPaidInvoice(db.repo, "acc_1", paid("in_m2", "2026-10-01T00:00:00Z"));
    expect(db.lines.map((l) => l.month_index)).toEqual([1, 2]);
  });

  it("doesn't count $0 invoices, one-off invoices or other subscriptions as a paid month", async () => {
    const { db } = setup();
    await processPaidInvoice(db.repo, "acc_1", paid("in_m1", "2026-09-01T00:00:00Z"));
    await processPaidInvoice(db.repo, "acc_1", paid("in_zero", "2026-10-01T00:00:00Z", { amountPaidCents: 0 }));
    await processPaidInvoice(db.repo, "acc_1", paid("in_manual", "2026-10-02T00:00:00Z", { billingReason: "manual" }));
    await processPaidInvoice(db.repo, "acc_1", paid("in_other", "2026-10-03T00:00:00Z", { subscriptionId: "sub_2" }));
    expect(db.lines.map((l) => l.stripe_invoice_id)).toEqual(["in_m1"]);
  });

  it("rounds each month's fee down to the cent", async () => {
    const db = fakeLedger();
    db.addAccount();
    db.addSave({ saved_mrr_cents: 999, created_at: ACCEPTED.toISOString() });
    await processPaidInvoice(db.repo, "acc_1", paid("in_m1", "2026-09-01T00:00:00Z"));
    expect(db.lines[0]!.amount_cents).toBe(199); // 199.8 -> 199
  });

  it("stops adding months once the subscription is cancelled; earned fees stand", async () => {
    const { db, save } = setup();
    await processPaidInvoice(db.repo, "acc_1", paid("in_m1", "2026-09-01T00:00:00Z"));
    const out = await endSavesForSubscription(db.repo, "acc_1", "sub_1", new Date("2026-09-15T00:00:00Z"));
    expect(out).toEqual({ lost: [], ended: [save.id] });
    await processPaidInvoice(db.repo, "acc_1", paid("in_m2", "2026-10-01T00:00:00Z"));
    expect(db.lines).toHaveLength(1);
    expect(db.saves.get(save.id)).toMatchObject({ status: "verified", end_reason: "customer_canceled", fee_cents: 1_400 });
    expect(db.eventsFor(save.id)).toContain("ended");
  });

  it("holds a new month's line while the founder's dispute of the save is open", async () => {
    const { db, save } = setup();
    await processPaidInvoice(db.repo, "acc_1", paid("in_m1", "2026-09-01T00:00:00Z"));
    db.saves.get(save.id)!.status = "disputed";
    const dispute = await db.repo.insertDispute({
      save_id: save.id,
      account_id: "acc_1",
      opened_by: null,
      reason: "x",
      category: "would_have_stayed",
      note: null,
      created_at: ACCEPTED.toISOString(),
    });
    await processPaidInvoice(db.repo, "acc_1", paid("in_m2", "2026-10-01T00:00:00Z"));
    expect(db.lines.find((l) => l.month_index === 2)!.held_founder_dispute_id).toBe(dispute!.id);
  });
});

describe("decideNextFeeMonth (pure)", () => {
  const save = {
    id: "s",
    type: "cancel" as const,
    status: "verified" as const,
    stripe_subscription_id: "sub_1",
    created_at: ACCEPTED.toISOString(),
    saved_mrr_cents: 1000,
    ended_at: null,
  };
  const inv = { id: "in_x", subscriptionId: "sub_1", amountPaidCents: 1000, createdUnix: unix("2026-10-01T00:00:00Z"), billingReason: "subscription_cycle" };
  it("numbers months from the existing lines", () => {
    expect(decideNextFeeMonth(save, [{ month_index: 1, stripe_invoice_id: "in_1" }], inv)).toEqual({ add: true, monthIndex: 2 });
  });
  it("refuses pending, lost and clawed-back saves", () => {
    for (const status of ["pending", "lost", "clawed_back"] as const) {
      expect(decideNextFeeMonth({ ...save, status }, [], inv).add).toBe(false);
    }
  });
});

describe("pending saves are lost when they can't be verified", () => {
  it("expire 45 days after the offer with no qualifying paid invoice", async () => {
    const { db, save } = setup();
    expect(await expirePendingSaves(db.repo, new Date(ACCEPTED.getTime() + 44 * DAY))).toEqual([]);
    expect(await expirePendingSaves(db.repo, new Date(ACCEPTED.getTime() + 45 * DAY + 1))).toEqual([save.id]);
    expect(db.saves.get(save.id)).toMatchObject({ status: "lost", lost_reason: "expired" });
    // An invoice paid after expiry no longer verifies it.
    await processPaidInvoice(db.repo, "acc_1", paid("in_late", "2026-10-01T00:00:00Z"));
    expect(db.saves.get(save.id)!.status).toBe("lost");
    expect(db.lines).toHaveLength(0);
  });

  it("uses a configurable window", async () => {
    const { db, save } = setup();
    expect(verifyWindowDays("30")).toBe(30);
    expect(verifyWindowDays("nonsense")).toBe(45);
    expect(verifyWindowDays(undefined)).toBe(45);
    expect(await expirePendingSaves(db.repo, new Date(ACCEPTED.getTime() + 31 * DAY), 30)).toEqual([save.id]);
  });

  it("measures the window from the end of a pause", async () => {
    const db = fakeLedger();
    db.addAccount();
    const resumes = new Date(ACCEPTED.getTime() + 60 * DAY).toISOString();
    const save = db.addSave({ created_at: ACCEPTED.toISOString(), offer: { type: "pause", months: 2, resumes_at: resumes } });
    expect(pendingDeadline(db.saves.get(save.id)!).toISOString()).toBe(new Date(ACCEPTED.getTime() + 105 * DAY).toISOString());
    expect(await expirePendingSaves(db.repo, new Date(ACCEPTED.getTime() + 90 * DAY))).toEqual([]);
    expect(await expirePendingSaves(db.repo, new Date(ACCEPTED.getTime() + 106 * DAY))).toEqual([save.id]);
  });

  it("are lost when the customer cancels the subscription", async () => {
    const { db, save } = setup();
    const out = await endSavesForSubscription(db.repo, "acc_1", "sub_1", new Date("2026-08-20T00:00:00Z"));
    expect(out).toEqual({ lost: [save.id], ended: [] });
    expect(db.saves.get(save.id)).toMatchObject({ status: "lost", lost_reason: "customer_canceled" });
    expect(db.eventsFor(save.id)).toEqual(["lost"]);
  });

  it("are superseded by a newer accepted offer on the same subscription", async () => {
    const { db, save } = setup();
    const newer = db.addSave({ created_at: new Date(ACCEPTED.getTime() + 5 * DAY).toISOString() });
    const other = db.addSave({ stripe_subscription_id: "sub_2" });
    const lost = await supersedePendingSaves(db.repo, "acc_1", "sub_1", newer.cancel_session_id!, new Date(ACCEPTED.getTime() + 5 * DAY));
    expect(lost).toEqual([save.id]);
    expect(db.saves.get(save.id)).toMatchObject({ status: "lost", lost_reason: "superseded" });
    expect(db.saves.get(newer.id)!.status).toBe("pending");
    expect(db.saves.get(other.id)!.status).toBe("pending");
    // Only the newer save can be verified now.
    const result = await processPaidInvoice(db.repo, "acc_1", paid("in_m1", "2026-09-01T00:00:00Z"));
    expect(result.verified).toEqual([newer.id]);
  });

  it("keeps the current session's save when that session cancels nothing (keepSessionId)", async () => {
    const { db, save } = setup();
    await endSavesForSubscription(db.repo, "acc_1", "sub_1", new Date(), { keepSessionId: save.cancel_session_id });
    expect(db.saves.get(save.id)!.status).toBe("pending");
  });

  it("never touches a verified save's status when expiring", async () => {
    const { db, save } = setup();
    await processPaidInvoice(db.repo, "acc_1", paid("in_m1", "2026-09-01T00:00:00Z"));
    expect(await expirePendingSaves(db.repo, new Date(ACCEPTED.getTime() + 400 * DAY))).toEqual([]);
    expect(db.saves.get(save.id)!.status).toBe("verified");
  });
});

describe("abandoned cancel sessions", () => {
  it("marks sessions still 'started' after 24 hours as abandoned", async () => {
    const db = fakeLedger();
    const now = new Date("2026-10-12T12:00:00Z");
    const old = db.addSession({ started_at: "2026-10-11T11:59:00Z" });
    const fresh = db.addSession({ started_at: "2026-10-11T12:30:00Z" });
    const done = db.addSession({ started_at: "2026-10-01T00:00:00Z", status: "canceled" });
    expect(await abandonStaleSessions(db.repo, now)).toBe(1);
    expect([old.status, fresh.status, done.status]).toEqual(["abandoned", "started", "canceled"]);
  });
});
