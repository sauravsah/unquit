import { describe, expect, it } from "vitest";
import {
  DEFAULT_SCHEDULE_DAYS,
  MIN_GAP_MS,
  decideSequenceAction,
  firstEmailAt,
  isValidSchedule,
  nextEmailAfter,
  scheduledAt,
  subscriptionEndsDunning,
  type SequenceCase,
} from "./schedule";

const DAY = 86_400_000;
const opened = new Date("2026-10-01T10:00:00Z");
const open = (over: Partial<SequenceCase> = {}): SequenceCase => ({
  status: "open",
  sequence_step: 0,
  next_email_at: opened.toISOString(),
  customer_email: "c@example.com",
  opened_at: opened.toISOString(),
  ...over,
});
const live = { invoiceStatus: "open", subscriptionStatus: "past_due" };

describe("schedule", () => {
  it("defaults to day 0, 3 and 7", () => {
    expect(DEFAULT_SCHEDULE_DAYS).toEqual([0, 3, 7]);
    expect(firstEmailAt(opened, DEFAULT_SCHEDULE_DAYS)).toEqual(opened);
    expect(scheduledAt(opened, DEFAULT_SCHEDULE_DAYS, 1)).toEqual(new Date(opened.getTime() + 3 * DAY));
    expect(scheduledAt(opened, DEFAULT_SCHEDULE_DAYS, 2)).toEqual(new Date(opened.getTime() + 7 * DAY));
  });

  it("honours a per-account schedule", () => {
    expect(firstEmailAt(opened, [1, 5, 14])).toEqual(new Date(opened.getTime() + DAY));
    expect(scheduledAt(opened, [1, 5, 14], 2)).toEqual(new Date(opened.getTime() + 14 * DAY));
  });

  it("validates schedules", () => {
    expect(isValidSchedule([0, 3, 7])).toBe(true);
    expect(isValidSchedule([2, 10, 60])).toBe(true);
    for (const bad of [[0, 3], [0, 3, 3], [3, 0, 7], [-1, 3, 7], [0, 3, 61], [0, 1.5, 3], "0,3,7", null, [0, 3, 7, 9]]) {
      expect(isValidSchedule(bad)).toBe(false);
    }
  });

  it("schedules the next email from the case's opening, and nothing after the third", () => {
    const sentAt = new Date(opened.getTime() + 60_000);
    expect(nextEmailAfter(0, opened, DEFAULT_SCHEDULE_DAYS, sentAt)).toEqual(new Date(opened.getTime() + 3 * DAY));
    expect(nextEmailAfter(1, opened, DEFAULT_SCHEDULE_DAYS, sentAt)).toEqual(new Date(opened.getTime() + 7 * DAY));
    expect(nextEmailAfter(2, opened, DEFAULT_SCHEDULE_DAYS, sentAt)).toBeNull();
  });

  it("never sends two emails back to back after a late run", () => {
    const late = new Date(opened.getTime() + 6.8 * DAY); // email 2 went out almost 4 days late
    expect(nextEmailAfter(1, opened, DEFAULT_SCHEDULE_DAYS, late)).toEqual(new Date(late.getTime() + MIN_GAP_MS));
  });
});

describe("decideSequenceAction", () => {
  const now = new Date(opened.getTime() + 1000);

  it("sends the due step", () => {
    expect(decideSequenceAction(open(), live, now)).toEqual({ action: "send", step: 0 });
    expect(decideSequenceAction(open({ sequence_step: 2 }), live, now)).toEqual({ action: "send", step: 2 });
  });

  it("waits until the email is due", () => {
    expect(decideSequenceAction(open({ next_email_at: new Date(now.getTime() + 1).toISOString() }), live, now)).toEqual({ action: "wait" });
    expect(decideSequenceAction(open({ next_email_at: null }), live, now)).toEqual({ action: "wait" });
  });

  it("stops the moment the invoice is paid", () => {
    expect(decideSequenceAction(open(), { ...live, invoiceStatus: "paid" }, now)).toEqual({ action: "stop", reason: "paid" });
  });

  it("stops when the subscription is cancelled", () => {
    expect(decideSequenceAction(open(), { ...live, subscriptionStatus: "canceled" }, now)).toEqual({ action: "stop", reason: "canceled" });
    expect(decideSequenceAction(open(), { ...live, subscriptionStatus: "incomplete_expired" }, now)).toEqual({
      action: "stop",
      reason: "canceled",
    });
  });

  it("stops when the invoice was voided or written off", () => {
    for (const status of ["void", "uncollectible", "deleted"]) {
      expect(decideSequenceAction(open(), { ...live, invoiceStatus: status }, now)).toEqual({ action: "stop", reason: "invoice_closed" });
    }
  });

  it("stops after the third email, without a customer email, or on a stale case", () => {
    expect(decideSequenceAction(open({ sequence_step: 3 }), live, now)).toEqual({ action: "stop", reason: "completed" });
    expect(decideSequenceAction(open({ customer_email: null }), live, now)).toEqual({ action: "stop", reason: "no_email" });
    expect(decideSequenceAction(open(), live, new Date(opened.getTime() + 31 * DAY))).toEqual({ action: "stop", reason: "completed" });
  });

  it("does nothing for cases that are no longer open", () => {
    for (const status of ["recovered", "closed", "failed"] as const) {
      expect(decideSequenceAction(open({ status }), live, now)).toEqual({ action: "skip" });
    }
  });

  it("keeps going when Stripe's state is unknown", () => {
    expect(decideSequenceAction(open(), null, now)).toEqual({ action: "send", step: 0 });
    expect(decideSequenceAction(open(), { invoiceStatus: null, subscriptionStatus: null }, now)).toEqual({ action: "send", step: 0 });
  });

  it("knows which subscription statuses end dunning", () => {
    expect(subscriptionEndsDunning("canceled")).toBe(true);
    expect(subscriptionEndsDunning("past_due")).toBe(false);
    expect(subscriptionEndsDunning("unpaid")).toBe(false);
  });
});
