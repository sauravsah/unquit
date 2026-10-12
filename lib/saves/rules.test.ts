import { describe, expect, it } from "vitest";
import { billingMonthOf, decideCancelSaveVerification, type PaidInvoice, type PendingCancelSave } from "./rules";

const acceptedAt = "2026-10-01T12:00:00.000Z";
const afterAccept = Date.parse(acceptedAt) / 1000 + 86_400;

const save: PendingCancelSave = {
  id: "save_1",
  type: "cancel",
  status: "pending",
  stripe_subscription_id: "sub_1",
  created_at: acceptedAt,
};

const invoice: PaidInvoice = {
  id: "in_1",
  subscriptionId: "sub_1",
  amountPaidCents: 4_900,
  createdUnix: afterAccept,
  billingReason: "subscription_cycle",
};

describe("cancel save verification", () => {
  it("verifies when the next invoice on the same subscription is paid", () => {
    expect(decideCancelSaveVerification(save, invoice)).toEqual({ verify: true });
  });

  it("rejects an invoice from a different subscription", () => {
    expect(decideCancelSaveVerification(save, { ...invoice, subscriptionId: "sub_2" }).verify).toBe(false);
  });

  it("rejects an invoice created before the offer was accepted", () => {
    const before = Date.parse(acceptedAt) / 1000 - 60;
    expect(decideCancelSaveVerification(save, { ...invoice, createdUnix: before }).verify).toBe(false);
  });

  it("keeps the save pending on a $0 invoice (free month / pause)", () => {
    expect(decideCancelSaveVerification(save, { ...invoice, amountPaidCents: 0 }).verify).toBe(false);
  });

  it("ignores one-off manual invoices", () => {
    expect(decideCancelSaveVerification(save, { ...invoice, billingReason: "manual" }).verify).toBe(false);
  });

  it("does not re-verify a save that is not pending", () => {
    expect(decideCancelSaveVerification({ ...save, status: "verified" }, invoice).verify).toBe(false);
    expect(decideCancelSaveVerification({ ...save, status: "clawed_back" }, invoice).verify).toBe(false);
  });

  it("only applies to cancel saves", () => {
    expect(decideCancelSaveVerification({ ...save, type: "dunning" }, invoice).verify).toBe(false);
  });
});

describe("billingMonthOf", () => {
  it("returns the first of the month in UTC", () => {
    expect(billingMonthOf(Date.parse("2026-10-31T23:59:00Z") / 1000)).toBe("2026-10-01");
    expect(billingMonthOf(Date.parse("2027-01-01T00:00:00Z") / 1000)).toBe("2027-01-01");
  });
});
