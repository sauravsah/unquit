/**
 * Emails unquit sends to FOUNDERS (not their customers): a receipt for each
 * verified save, the outcome of a dispute, and a heads-up to admins when a
 * dispute needs review. Table-based HTML with inline styles + plain text,
 * like the dunning emails.
 */
import { escapeHtml } from "@/lib/dunning/templates";
import { formatCents, OVERLAP_RECOVERY_LABEL } from "@/lib/pricing";
import type { DisputeCategory, DisputeRow, SaveRow } from "./types";

export type RenderedEmail = { subject: string; html: string; text: string };

export const DISPUTE_CATEGORY_LABELS: Record<DisputeCategory, string> = {
  would_have_stayed: "The customer would have stayed anyway",
  wrong_customer: "Wrong customer",
  refunded: "The customer was refunded",
  other: "Other",
};

const FONT = "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;";

/** The U-turn mark, served from the app itself (same origin as the email's button link). */
function logoImg(href?: string): string {
  let origin: string | null = null;
  try {
    origin = href ? new URL(href).origin : null;
  } catch {
    origin = null;
  }
  return origin
    ? `<img src="${escapeHtml(origin)}/logo-mark.png" width="24" height="24" alt="" style="display:inline-block;vertical-align:-5px;margin-right:6px;border:0;">`
    : "";
}

export function layout(title: string, rows: string[], button?: { href: string; label: string }): string {
  const mark = logoImg(button?.href);
  const btn = button
    ? `<tr><td style="padding:8px 0 24px 0;"><table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td style="border-radius:8px;background:#16A34A;">
<a href="${escapeHtml(button.href)}" target="_blank" style="display:inline-block;padding:12px 20px;${FONT}font-size:15px;font-weight:bold;color:#ffffff;text-decoration:none;border-radius:8px;">${escapeHtml(button.label)}</a>
</td></tr></table></td></tr>`
    : "";
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escapeHtml(title)}</title></head>
<body style="margin:0;padding:0;background:#ffffff;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td align="center" style="padding:32px 16px;">
<table role="presentation" width="560" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;width:100%;">
<tr><td style="padding:0 0 24px 0;${FONT}font-size:20px;font-weight:bold;color:#0A0A0A;">${mark}unquit<span style="color:#16A34A;">.</span></td></tr>
${rows.map((r) => `<tr><td style="padding:0 0 16px 0;${FONT}font-size:15px;line-height:22px;color:#262626;">${r}</td></tr>`).join("\n")}
${btn}
<tr><td style="border-top:1px solid #E5E5E5;padding:16px 0 0 0;${FONT}font-size:12px;line-height:18px;color:#737373;">You get these emails because you use unquit for churn recovery. Fees round down to the cent and are capped at $299 a month.</td></tr>
</table></td></tr></table></body></html>`;
}

export function saveSummary(save: Pick<SaveRow, "type" | "saved_mrr_cents" | "recovered_amount_cents" | "currency">): string {
  return save.type === "cancel"
    ? `${formatCents(Number(save.saved_mrr_cents), save.currency)}/mo of MRR kept`
    : `${formatCents(Number(save.recovered_amount_cents), save.currency)} failed payment recovered`;
}

export function feeSummary(save: Pick<SaveRow, "type" | "saved_mrr_cents" | "fee_cents">, opts: { overlap?: boolean } = {}): string {
  if (save.type === "cancel") {
    return `${formatCents(Math.floor((Number(save.saved_mrr_cents) * 2000) / 10_000))} this month (20% of the saved MRR), and the same for up to 2 more paid months. After that, it's free.`;
  }
  return opts.overlap
    ? `${formatCents(Number(save.fee_cents))}, once. ${OVERLAP_RECOVERY_LABEL} of the recovered amount, because this invoice also counts toward an active cancel save.`
    : `${formatCents(Number(save.fee_cents))}, once (10% of the recovered amount).`;
}

export function receiptEmail(save: SaveRow, receiptUrl: string, opts: { overlap?: boolean } = {}): RenderedEmail {
  const kind = save.type === "cancel" ? "Cancel save" : "Failed-payment recovery";
  const who = save.customer_email ?? save.stripe_customer_id;
  const subject = `Receipt ${save.receipt_number}: ${saveSummary(save)}`;
  const rows = [
    `<strong>${escapeHtml(kind)} verified.</strong> ${escapeHtml(who)}: ${escapeHtml(saveSummary(save))}.`,
    `Fee: ${escapeHtml(feeSummary(save, opts))}`,
    `The receipt shows the Stripe invoice that proved it. If this save shouldn't count, press <em>Dispute this save</em> on the receipt and the fee is held while we look.`,
  ];
  const text = [
    `${kind} verified (${save.receipt_number}).`,
    `${who}: ${saveSummary(save)}.`,
    `Fee: ${feeSummary(save, opts)}`,
    "",
    `Receipt and Dispute button: ${receiptUrl}`,
  ].join("\n");
  return { subject, html: layout(subject, rows, { href: receiptUrl, label: "View receipt" }), text };
}

export function disputeOutcomeEmail(save: SaveRow, dispute: DisputeRow, receiptUrl: string): RenderedEmail {
  const accepted = dispute.status === "accepted";
  const subject = accepted
    ? `Dispute accepted: the fee for ${save.receipt_number} is reversed`
    : `Dispute reviewed: the fee for ${save.receipt_number} stands`;
  const why =
    dispute.resolution === "auto"
      ? "Our automatic checks of the Stripe invoice didn't hold up, so the fee was reversed straight away."
      : accepted
        ? "We reviewed it and agree. The fee is reversed and won't be billed (or is credited on your next statement)."
        : "We reviewed it and the save checks out, so the fee stays on your statement.";
  const note = dispute.resolution_note ? `Note from the reviewer: “${escapeHtml(dispute.resolution_note)}”` : null;
  const rows = [`<strong>${escapeHtml(subject)}.</strong>`, escapeHtml(why), ...(note ? [note] : [])];
  const text = [
    subject + ".",
    why,
    ...(dispute.resolution_note ? [`Note from the reviewer: ${dispute.resolution_note}`] : []),
    "",
    `Receipt: ${receiptUrl}`,
  ].join("\n");
  return { subject, html: layout(subject, rows, { href: receiptUrl, label: "View receipt" }), text };
}

export function adminDisputeEmail(save: SaveRow, dispute: DisputeRow, adminUrl: string): RenderedEmail {
  const subject = `New dispute to review: ${save.receipt_number}`;
  const rows = [
    `<strong>${escapeHtml(DISPUTE_CATEGORY_LABELS[dispute.category])}</strong>`,
    dispute.note ? `“${escapeHtml(dispute.note)}”` : "No note.",
    `Save: ${escapeHtml(save.type)} · ${escapeHtml(saveSummary(save))} · fee ${escapeHtml(formatCents(Number(save.fee_cents)))} (held).`,
  ];
  const text = [subject, DISPUTE_CATEGORY_LABELS[dispute.category], dispute.note ?? "No note.", "", `Review: ${adminUrl}`].join("\n");
  return { subject, html: layout(subject, rows, { href: adminUrl, label: "Open the review queue" }), text };
}
