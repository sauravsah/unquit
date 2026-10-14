/**
 * Emails to FOUNDERS about unquit's own charges: a payment failed (we'll
 * retry), a statement is unpaid (update your card, or unquit pauses in 3
 * days), the account is paused, and it resumed. Sent through the
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

/** What the unpaid-statement email says about pausing (lib/billing/pause.ts). */
export type PauseNotice = { kind: "warning"; pauseOn: Date } | { kind: "paused" } | null;

export function paymentUnpaidEmail(input: { amountCents: number; periodLabel: string; reason: string; billingUrl: string; pause?: PauseNotice }): RenderedEmail {
  const amount = formatCents(input.amountCents);
  const pause = input.pause ?? null;
  const subject =
    pause?.kind === "warning"
      ? `Action needed: unquit will pause in 3 days unless you update your card (${amount} unpaid)`
      : `Action needed: update your card for unquit (${amount} unpaid)`;
  const pauseLine =
    pause?.kind === "warning"
      ? `Unquit will pause on ${dateLabel(pause.pauseOn)} unless the card is updated. While paused, your cancel flow shows no offers and no failed-payment emails go out, but your customers can still cancel. Paying resumes everything straight away.`
      : pause?.kind === "paused"
        ? "Unquit is paused until this is paid: your cancel flow shows no offers and no failed-payment emails go out. Your customers can still cancel. Paying resumes everything straight away."
        : null;
  const html = layout(
    subject,
    [
      `We couldn't collect ${escapeHtml(amount)} for your unquit fees for ${escapeHtml(input.periodLabel)}. ${escapeHtml(input.reason)}`,
      ...(pauseLine ? [escapeHtml(pauseLine)] : []),
      "Please add a new card in your billing settings. We'll charge it once, straight after you save it.",
    ],
    { href: input.billingUrl, label: "Update card" },
  );
  const text = [
    `We couldn't collect ${amount} for your unquit fees for ${input.periodLabel}. ${input.reason}`,
    ...(pauseLine ? [pauseLine] : []),
    `Please add a new card: ${input.billingUrl}. We'll charge it once, straight after you save it.`,
  ].join("\n\n");
  return { subject, html, text };
}

/** Sent when the grace period ends (or an admin pauses the account). */
export function accountPausedEmail(input: { amountCents: number; billingUrl: string; byAdmin?: boolean }): RenderedEmail {
  const amount = formatCents(input.amountCents);
  const subject = "Unquit is paused: update your card to resume";
  const first = input.byAdmin
    ? "Your Unquit account has been paused by the Unquit team."
    : `Your Unquit account is paused because ${amount} in fees is still unpaid.`;
  const rows = [
    first,
    "While paused, your cancel flow shows no offers and Unquit sends no failed-payment emails or retries. Your customers can still cancel as normal, and saves already in progress keep being recorded, so nothing is lost.",
    input.byAdmin ? "Reply to this email if you have questions." : "Update your card and we'll charge it straight away. Unquit resumes automatically the moment the bill is paid.",
  ];
  const html = layout(subject, rows.map(escapeHtml), { href: input.billingUrl, label: "Update card and resume" });
  const text = [...rows, input.billingUrl].join("\n\n");
  return { subject, html, text };
}

/** Sent when a paused account resumes (bill paid, or an admin resumed it). */
export function accountResumedEmail(input: { billingUrl: string }): RenderedEmail {
  const subject = "Unquit is back on";
  const rows = [
    "Thanks, your Unquit account is active again.",
    "Your cancel flow shows offers again and failed-payment emails pick up from where they stopped.",
  ];
  const html = layout(subject, rows.map(escapeHtml), { href: input.billingUrl, label: "View billing" });
  const text = [...rows, input.billingUrl].join("\n\n");
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
