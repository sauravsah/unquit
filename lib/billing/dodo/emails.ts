/**
 * Emails to FOUNDERS about unquit's own charges: a payment failed (we'll
 * retry), or a statement is unpaid (update your card). Sent through the
 * existing founder mailer; without RESEND_API_KEY they're only logged.
 */
import { escapeHtml } from "@/lib/dunning/templates";
import { layout, type RenderedEmail } from "@/lib/ledger/emails";
import { formatCents } from "@/lib/pricing";

const dateLabel = (d: Date) => d.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });

export function paymentFailedEmail(input: { amountCents: number; periodLabel: string; reason: string; nextAttemptAt: Date; billingUrl: string }): RenderedEmail {
  const amount = formatCents(input.amountCents);
  const when = dateLabel(input.nextAttemptAt);
  const subject = `Your unquit payment of ${amount} didn't go through`;
  const html = layout(
    subject,
    [
      `We tried to charge ${escapeHtml(amount)} for your unquit fees for ${escapeHtml(input.periodLabel)}. ${escapeHtml(input.reason)}`,
      `We'll try the same card again on ${escapeHtml(when)}. If you'd like to use a different card, update it in your billing settings before then.`,
      "Nothing about your cancel flow or failed-payment emails changes in the meantime.",
    ],
    { href: input.billingUrl, label: "Update card" },
  );
  const text = [
    `We tried to charge ${amount} for your unquit fees for ${input.periodLabel}. ${input.reason}`,
    `We'll try the same card again on ${when}. To use a different card, update it before then: ${input.billingUrl}`,
    "Nothing about your cancel flow or failed-payment emails changes in the meantime.",
  ].join("\n\n");
  return { subject, html, text };
}

export function paymentUnpaidEmail(input: { amountCents: number; periodLabel: string; reason: string; billingUrl: string }): RenderedEmail {
  const amount = formatCents(input.amountCents);
  const subject = `Action needed: update your card for unquit (${amount} unpaid)`;
  const html = layout(
    subject,
    [
      `We couldn't collect ${escapeHtml(amount)} for your unquit fees for ${escapeHtml(input.periodLabel)}. ${escapeHtml(input.reason)}`,
      "Please add a new card in your billing settings. We'll charge it once, straight after you save it.",
    ],
    { href: input.billingUrl, label: "Update card" },
  );
  const text = [
    `We couldn't collect ${amount} for your unquit fees for ${input.periodLabel}. ${input.reason}`,
    `Please add a new card: ${input.billingUrl}. We'll charge it once, straight after you save it.`,
  ].join("\n\n");
  return { subject, html, text };
}

export function addCardEmail(input: { amountCents: number; periodLabel: string; billingUrl: string }): RenderedEmail {
  const amount = formatCents(input.amountCents);
  const subject = `Add a card to pay your unquit statement (${amount})`;
  const html = layout(
    subject,
    [
      `Your unquit statement for ${escapeHtml(input.periodLabel)} comes to ${escapeHtml(amount)}, and there's no card on file to charge.`,
      "Add one in your billing settings and we'll charge it automatically. You only ever pay for saves unquit can prove, capped at $299 a month.",
    ],
    { href: input.billingUrl, label: "Add a card" },
  );
  const text = [
    `Your unquit statement for ${input.periodLabel} comes to ${amount}, and there's no card on file to charge.`,
    `Add one and we'll charge it automatically: ${input.billingUrl}`,
  ].join("\n\n");
  return { subject, html, text };
}
