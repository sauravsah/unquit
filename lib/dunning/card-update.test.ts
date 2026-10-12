import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
import {
  CardUpdateError,
  confirmAfterAction,
  loadUpdatePage,
  payWithNewCard,
  retryCurrentCard,
  startCardUpdate,
  type CardUpdateDeps,
} from "./card-update";
import { fakeCardStripe, fakeRepo } from "./testing/fakes";
import { issueLinkToken } from "./token";

const SECRET = "test-link-secret-0123456789abcdef0123456789";
const T0 = new Date("2026-10-05T09:00:00Z");
const company = async () => "Acme";

function setup() {
  let now = T0;
  const db = fakeRepo({ clock: () => now });
  const c = db.addCase({ stripe_invoice_id: "in_42", amount_due_cents: 4_900, link_first_opened_at: null });
  const stripe = fakeCardStripe({
    invoice: {
      id: "in_42",
      customerId: "cus_1",
      subscriptionId: "sub_1",
      amountDueCents: 4_900,
      amountRemainingCents: 4_900,
      currency: "usd",
      number: "ACME-0042",
      hostedInvoiceUrl: "https://invoice.stripe.com/i/42",
    },
  });
  stripe.behaviour.paidAtUnix = Math.floor(T0.getTime() / 1000) + 30;
  const deps: CardUpdateDeps = { repo: db.repo, stripe: stripe.stripe, linkSecret: SECRET, now: () => now };
  const token = issueLinkToken(c.id, c.link_nonce, SECRET, T0);
  return {
    db,
    c,
    stripe,
    deps,
    token,
    at(ms: number) {
      now = new Date(T0.getTime() + ms);
    },
  };
}

describe("the card-update page", () => {
  it("shows the company, amount and invoice, and records that the link was opened", async () => {
    const t = setup();
    const page = await loadUpdatePage(t.deps, t.token, company);
    expect(page).toMatchObject({
      state: "ok",
      company: "Acme",
      amountCents: 4_900,
      currency: "usd",
      invoiceNumber: "ACME-0042",
      hostedInvoiceUrl: "https://invoice.stripe.com/i/42",
      stripeAccount: "acct_1",
    });
    expect(t.db.cases.get(t.c.id)!.link_first_opened_at).toBe(T0.toISOString());
  });

  it("rejects forged, expired and unknown links", async () => {
    const t = setup();
    expect(await loadUpdatePage(t.deps, `${t.token}x`, company)).toEqual({ state: "invalid", company: null });
    t.at(15 * 86_400_000);
    expect(await loadUpdatePage(t.deps, t.token, company)).toEqual({ state: "expired", company: null });
    const stranger = issueLinkToken("99999999-9999-4999-8999-999999999999", t.c.link_nonce, SECRET, T0);
    t.at(0);
    expect(await loadUpdatePage(t.deps, stranger, company)).toEqual({ state: "invalid", company: null });
  });

  it("shows 'already paid' if Stripe has the invoice paid", async () => {
    const t = setup();
    t.stripe.invoice.status = "paid";
    t.stripe.invoice.amountPaidCents = 4_900;
    expect(await loadUpdatePage(t.deps, t.token, company)).toMatchObject({ state: "paid", amountCents: 4_900 });
  });

  it("collects a new card, makes it the default, pays the invoice and credits Unquit", async () => {
    const t = setup();
    await loadUpdatePage(t.deps, t.token, company);
    const start = await startCardUpdate(t.deps, t.token);
    expect(start).toMatchObject({ status: "ready", stripeAccount: "acct_1" });
    const seti = [...t.stripe.setupIntents.keys()][0]!;
    expect(t.stripe.setupIntents.get(seti)).toMatchObject({ customerId: "cus_1", caseId: t.c.id });

    t.stripe.confirmSetup(seti, "pm_new_card"); // Stripe.js, including any 3DS on the card
    t.at(20_000);
    const result = await payWithNewCard(t.deps, t.token, seti);
    expect(result).toEqual({ status: "paid", amountCents: 4_900, currency: "usd" });
    expect(t.stripe.defaults).toEqual([{ customerId: "cus_1", subscriptionId: "sub_1", paymentMethodId: "pm_new_card" }]);
    expect(t.stripe.payCalls).toEqual([{ paymentMethodId: "pm_new_card", idempotencyKey: `unquit_pay_${t.c.id}_${seti}` }]);
    expect(t.db.saves).toEqual([expect.objectContaining({ attributedVia: "update_link", recoveredAmountCents: 4_900, feeCents: 490 })]);
    expect(t.db.cases.get(t.c.id)).toMatchObject({ status: "recovered", recovered_via: "update_link" });
  });

  it("is single-use per success: the link stops working after the payment", async () => {
    const t = setup();
    await startCardUpdate(t.deps, t.token);
    const seti = [...t.stripe.setupIntents.keys()][0]!;
    t.stripe.confirmSetup(seti);
    await payWithNewCard(t.deps, t.token, seti);

    expect(await startCardUpdate(t.deps, t.token)).toEqual({ status: "link", state: "paid" });
    expect(await retryCurrentCard(t.deps, t.token)).toEqual({ status: "link", state: "paid" });
    expect(await payWithNewCard(t.deps, t.token, seti)).toEqual({ status: "link", state: "paid" });
    expect(await loadUpdatePage(t.deps, t.token, company)).toMatchObject({ state: "paid" });
    expect(t.stripe.payCalls).toHaveLength(1);
    expect(t.db.saves).toHaveLength(1);
  });

  it("keeps the link usable after a decline so the customer can try another card", async () => {
    const t = setup();
    await startCardUpdate(t.deps, t.token);
    const first = [...t.stripe.setupIntents.keys()][0]!;
    t.stripe.confirmSetup(first, "pm_bad");
    t.stripe.behaviour.next = "decline";
    expect(await payWithNewCard(t.deps, t.token, first)).toEqual({ status: "failed", message: "Your card was declined." });
    expect(t.db.cases.get(t.c.id)).toMatchObject({ status: "open", pending_attribution: null });

    t.at(61_000); // a new minute: a fresh SetupIntent
    t.stripe.behaviour.next = "succeed";
    await startCardUpdate(t.deps, t.token);
    const second = [...t.stripe.setupIntents.keys()][1]!;
    t.stripe.confirmSetup(second, "pm_good");
    expect(await payWithNewCard(t.deps, t.token, second)).toMatchObject({ status: "paid" });
  });

  it("handles 3-D Secure on the payment: requires_action, then confirm", async () => {
    const t = setup();
    await startCardUpdate(t.deps, t.token);
    const seti = [...t.stripe.setupIntents.keys()][0]!;
    t.stripe.confirmSetup(seti);
    t.stripe.behaviour.next = "requires_action";
    expect(await payWithNewCard(t.deps, t.token, seti)).toEqual({ status: "requires_action", clientSecret: "pi_123_secret_abc" });
    expect(t.db.cases.get(t.c.id)!.pending_attribution).toBe("update_link"); // still ours while the customer authenticates

    t.stripe.completeAction(); // the customer approved it in their banking app
    expect(await confirmAfterAction(t.deps, t.token)).toMatchObject({ status: "paid" });
    expect(t.db.saves).toEqual([expect.objectContaining({ attributedVia: "update_link" })]);
  });

  it("reports a failed 3DS challenge and clears the attribution mark", async () => {
    const t = setup();
    await startCardUpdate(t.deps, t.token);
    const seti = [...t.stripe.setupIntents.keys()][0]!;
    t.stripe.confirmSetup(seti);
    t.stripe.behaviour.next = "requires_action";
    await payWithNewCard(t.deps, t.token, seti);
    expect(await confirmAfterAction(t.deps, t.token)).toMatchObject({ status: "failed" });
    expect(t.db.cases.get(t.c.id)).toMatchObject({ status: "open", pending_attribution: null });
  });

  it("refuses a SetupIntent that isn't this case's (another customer, or not finished)", async () => {
    const t = setup();
    await startCardUpdate(t.deps, t.token);
    const seti = [...t.stripe.setupIntents.keys()][0]!;
    expect(await payWithNewCard(t.deps, t.token, seti)).toMatchObject({ status: "failed" }); // not confirmed yet
    t.stripe.setupIntents.get(seti)!.customerId = "cus_someone_else";
    t.stripe.confirmSetup(seti);
    await expect(payWithNewCard(t.deps, t.token, seti)).rejects.toBeInstanceOf(CardUpdateError);
    await expect(payWithNewCard(t.deps, t.token, "seti_missing")).rejects.toBeInstanceOf(CardUpdateError);
    await expect(payWithNewCard(t.deps, t.token, "pm_123")).rejects.toThrow(/Missing card details/);
    expect(t.stripe.payCalls).toHaveLength(0);
  });

  it("'Try my card again' pays with the card on file and credits unquit_retry after an email click", async () => {
    const t = setup();
    await loadUpdatePage(t.deps, t.token, company); // the customer arrived from the email
    t.at(10_000);
    expect(await retryCurrentCard(t.deps, t.token)).toMatchObject({ status: "paid" });
    expect(t.stripe.payCalls[0]).toMatchObject({ paymentMethodId: null });
    expect(t.db.saves).toEqual([expect.objectContaining({ attributedVia: "unquit_retry", feeCents: 490 })]);
  });

  it("a double-clicked retry pays once", async () => {
    const t = setup();
    await loadUpdatePage(t.deps, t.token, company);
    await Promise.all([retryCurrentCard(t.deps, t.token), retryCurrentCard(t.deps, t.token)]);
    expect(t.stripe.payCalls).toHaveLength(1);
    expect(t.db.saves).toHaveLength(1);
  });

  it("refuses to act on a closed case (subscription cancelled)", async () => {
    const t = setup();
    t.db.cases.get(t.c.id)!.status = "closed";
    expect(await startCardUpdate(t.deps, t.token)).toEqual({ status: "link", state: "closed" });
    expect(await loadUpdatePage(t.deps, t.token, company)).toEqual({ state: "closed", company: "Acme" });
  });
});
