/**
 * Dunning email copy and rendering.
 *
 * Founders edit a subject and a plain-text body per email. Bodies use blank
 * lines between paragraphs and these variables:
 *   {{customer_name}}  {{amount}}  {{update_link}}  {{company}}
 *
 * Rendering produces a table-based HTML email (works in Gmail and Outlook,
 * all styles inline, a "bulletproof" button) and a plain-text version. Every
 * email carries the card-update link as a button and in the text version,
 * even if the founder deletes {{update_link}} from the body.
 */
import { DECLINE_CATEGORIES, type DeclineCategory } from "./declines";
import { SEQUENCE_LENGTH } from "./schedule";

export type EmailTemplate = { subject: string; body: string };
export type TemplateSet = Record<DeclineCategory, EmailTemplate[]>;

export const TEMPLATE_VARIABLES = ["customer_name", "amount", "update_link", "company"] as const;
export type TemplateVariable = (typeof TEMPLATE_VARIABLES)[number];
export type TemplateVars = Record<TemplateVariable, string>;

export const TEMPLATE_LIMITS = { subject: 150, body: 5_000 } as const;

const SIGN_OFF = "Thanks,\nThe {{company}} team";

export const DEFAULT_TEMPLATES: TemplateSet = {
  soft: [
    {
      subject: "Your {{company}} payment didn't go through",
      body: `Hi {{customer_name}},

We tried to charge {{amount}} for your {{company}} subscription, but the payment didn't go through. This happens now and then, often because of a temporary hold or a low balance.

You don't need to do anything right now. We'll try your card again automatically over the next few days.

If you'd rather use a different card, you can update it in about a minute with the button below.

${SIGN_OFF}`,
    },
    {
      subject: "We'll try your {{company}} payment again soon",
      body: `Hi {{customer_name}},

A quick note: your {{amount}} payment for {{company}} still hasn't gone through. We'll keep retrying, but if anything changed with your card, updating it now is the fastest fix.

It takes about a minute, and your subscription keeps running as normal.

${SIGN_OFF}`,
    },
    {
      subject: "Last reminder about your {{company}} payment",
      body: `Hi {{customer_name}},

We still haven't been able to collect {{amount}} for your {{company}} subscription. If the payment keeps failing, your subscription may be paused or cancelled.

Please update your card, or try your current card again, using the button below. It only takes a minute.

${SIGN_OFF}`,
    },
  ],
  hard: [
    {
      subject: "Please update your card for {{company}}",
      body: `Hi {{customer_name}},

Your card was declined when we tried to charge {{amount}} for your {{company}} subscription. It may have expired or been replaced.

Please add a new card with the button below. It takes about a minute, and your subscription carries on as normal.

${SIGN_OFF}`,
    },
    {
      subject: "Reminder: your card for {{company}} needs updating",
      body: `Hi {{customer_name}},

Your {{amount}} payment for {{company}} is still outstanding because your card was declined.

Adding a new card takes about a minute. Once it's in, we'll take the payment straight away and you're all set.

${SIGN_OFF}`,
    },
    {
      subject: "Your {{company}} subscription is at risk",
      body: `Hi {{customer_name}},

This is our last reminder: we haven't been able to collect {{amount}} for your {{company}} subscription, so it may be cancelled soon.

If you'd like to keep it, please update your card with the button below.

${SIGN_OFF}`,
    },
  ],
  authentication_required: [
    {
      subject: "Please confirm your {{company}} payment",
      body: `Hi {{customer_name}},

Your bank needs you to confirm the {{amount}} payment for your {{company}} subscription. This is a normal security check (sometimes called 3-D Secure).

Use the button below to confirm it. You can keep the same card or add a new one, and it takes about a minute.

${SIGN_OFF}`,
    },
    {
      subject: "Reminder: your bank is waiting for you to confirm a payment",
      body: `Hi {{customer_name}},

Your {{amount}} payment for {{company}} is still waiting for your bank's approval.

Confirming it takes about a minute with the button below.

${SIGN_OFF}`,
    },
    {
      subject: "Last reminder: confirm your {{company}} payment",
      body: `Hi {{customer_name}},

We still need you to confirm the {{amount}} payment for your {{company}} subscription. Without it, your subscription may be cancelled soon.

Please confirm it with the button below.

${SIGN_OFF}`,
    },
  ],
};

export const CTA_LABELS: Record<DeclineCategory, string> = {
  soft: "Update your card",
  hard: "Update your card",
  authentication_required: "Confirm your payment",
};

const VARIABLE_PATTERN = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;

/** Variables used in a string that aren't supported. */
export function unknownVariables(text: string): string[] {
  const unknown = new Set<string>();
  for (const match of text.matchAll(VARIABLE_PATTERN)) {
    const name = match[1]!;
    if (!(TEMPLATE_VARIABLES as readonly string[]).includes(name)) unknown.add(name);
  }
  return [...unknown];
}

function isTemplate(value: unknown): value is EmailTemplate {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as EmailTemplate).subject === "string" &&
    typeof (value as EmailTemplate).body === "string"
  );
}

/** Validates the founder's templates. Missing categories fall back to defaults. */
export function parseTemplates(input: unknown): { ok: true; value: TemplateSet } | { ok: false; errors: string[] } {
  if (input === undefined || input === null) return { ok: true, value: cloneDefaults() };
  if (typeof input !== "object" || Array.isArray(input)) return { ok: false, errors: ["Templates must be an object."] };

  const errors: string[] = [];
  const value = cloneDefaults();
  for (const [key, list] of Object.entries(input as Record<string, unknown>)) {
    if (!(DECLINE_CATEGORIES as readonly string[]).includes(key)) {
      errors.push(`Unknown template group "${key}".`);
      continue;
    }
    const category = key as DeclineCategory;
    if (!Array.isArray(list) || list.length !== SEQUENCE_LENGTH || !list.every(isTemplate)) {
      errors.push(`${category}: needs exactly ${SEQUENCE_LENGTH} emails, each with a subject and a body.`);
      continue;
    }
    list.forEach((t, i) => {
      const label = `${category} email ${i + 1}`;
      const subject = t.subject.trim();
      const body = t.body.replace(/\r\n/g, "\n").trim();
      if (subject.length === 0) errors.push(`${label}: the subject is empty.`);
      if (subject.length > TEMPLATE_LIMITS.subject) errors.push(`${label}: the subject is over ${TEMPLATE_LIMITS.subject} characters.`);
      if (/[\r\n]/.test(subject)) errors.push(`${label}: the subject must be one line.`);
      if (body.length === 0) errors.push(`${label}: the body is empty.`);
      if (body.length > TEMPLATE_LIMITS.body) errors.push(`${label}: the body is over ${TEMPLATE_LIMITS.body} characters.`);
      for (const name of unknownVariables(`${subject}\n${body}`)) {
        errors.push(`${label}: {{${name}}} isn't a variable. Use ${TEMPLATE_VARIABLES.map((v) => `{{${v}}}`).join(", ")}.`);
      }
      value[category][i] = { subject, body };
    });
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, value };
}

/** Stored templates merged over the defaults. Invalid stored data falls back to the defaults. */
export function resolveTemplates(stored: unknown): TemplateSet {
  const parsed = parseTemplates(stored);
  return parsed.ok ? parsed.value : cloneDefaults();
}

export function cloneDefaults(): TemplateSet {
  return {
    soft: DEFAULT_TEMPLATES.soft.map((t) => ({ ...t })),
    hard: DEFAULT_TEMPLATES.hard.map((t) => ({ ...t })),
    authentication_required: DEFAULT_TEMPLATES.authentication_required.map((t) => ({ ...t })),
  };
}

/** Only the templates that differ from the built-in copy (what we store). */
export function templateOverrides(set: TemplateSet): Partial<TemplateSet> {
  const out: Partial<TemplateSet> = {};
  for (const category of DECLINE_CATEGORIES) {
    const differs = set[category].some(
      (t, i) => t.subject !== DEFAULT_TEMPLATES[category][i]!.subject || t.body !== DEFAULT_TEMPLATES[category][i]!.body,
    );
    if (differs) out[category] = set[category].map((t) => ({ ...t }));
  }
  return out;
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Replaces {{variables}} in plain text. Unknown variables are left as they are. */
export function fillText(text: string, vars: TemplateVars): string {
  return text.replace(VARIABLE_PATTERN, (whole, name: string) =>
    (TEMPLATE_VARIABLES as readonly string[]).includes(name) ? vars[name as TemplateVariable] : whole,
  );
}

/** Same, for HTML: text is escaped, and {{update_link}} becomes a real link. */
function fillHtml(text: string, vars: TemplateVars): string {
  const parts: string[] = [];
  let last = 0;
  for (const match of text.matchAll(VARIABLE_PATTERN)) {
    parts.push(escapeHtml(text.slice(last, match.index)));
    const name = match[1]!;
    if (name === "update_link") {
      const href = escapeHtml(vars.update_link);
      parts.push(`<a href="${href}" style="color:#15803D;text-decoration:underline;">${href}</a>`);
    } else if ((TEMPLATE_VARIABLES as readonly string[]).includes(name)) {
      parts.push(escapeHtml(vars[name as TemplateVariable]));
    } else {
      parts.push(escapeHtml(match[0]));
    }
    last = match.index! + match[0].length;
  }
  parts.push(escapeHtml(text.slice(last)));
  return parts.join("");
}

export type RenderedEmail = { subject: string; html: string; text: string };

/**
 * Renders one email. `vars.update_link` should be the click-tracking URL;
 * `openPixelUrl` (optional) adds a 1×1 open-tracking image.
 */
export function renderEmail(
  template: EmailTemplate,
  vars: TemplateVars,
  options: { category: DeclineCategory; openPixelUrl?: string },
): RenderedEmail {
  const subject = fillText(template.subject, vars).replace(/[\r\n]+/g, " ").trim();
  const paragraphs = template.body.replace(/\r\n/g, "\n").trim().split(/\n{2,}/);
  const cta = CTA_LABELS[options.category];
  const font = "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;";
  const link = escapeHtml(vars.update_link);

  const htmlParagraphs = paragraphs
    .map(
      (p) =>
        `<p style="margin:0 0 16px 0;${font}font-size:16px;line-height:24px;color:#0A0A0A;">${fillHtml(p, vars).replace(/\n/g, "<br>")}</p>`,
    )
    .join("\n");

  const pixel = options.openPixelUrl
    ? `<img src="${escapeHtml(options.openPixelUrl)}" width="1" height="1" alt="" style="display:block;border:0;width:1px;height:1px;">`
    : "";

  const html = `<!DOCTYPE html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="x-apple-disable-message-reformatting">
<title>${escapeHtml(subject)}</title>
</head>
<body style="margin:0;padding:0;background-color:#ffffff;">
<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;">${escapeHtml(cta)}: it takes about a minute.</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#ffffff;">
<tr><td align="center" style="padding:32px 16px;">
<table role="presentation" width="560" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:560px;">
<tr><td style="padding:0 0 24px 0;${font}font-size:18px;font-weight:bold;color:#0A0A0A;">${escapeHtml(vars.company)}</td></tr>
<tr><td>
${htmlParagraphs}
</td></tr>
<tr><td style="padding:8px 0 24px 0;">
<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
<td align="center" bgcolor="#16A34A" style="border-radius:8px;background-color:#16A34A;">
<a href="${link}" target="_blank" style="display:inline-block;padding:14px 24px;${font}font-size:16px;font-weight:bold;line-height:20px;color:#ffffff;text-decoration:none;border-radius:8px;">${escapeHtml(cta)}</a>
</td></tr></table>
</td></tr>
<tr><td style="padding:0 0 24px 0;${font}font-size:13px;line-height:20px;color:#525252;">If the button doesn't work, copy this link into your browser:<br><a href="${link}" style="color:#15803D;word-break:break-all;">${link}</a></td></tr>
<tr><td style="border-top:1px solid #E5E5E5;padding:16px 0 0 0;${font}font-size:12px;line-height:18px;color:#737373;">You're receiving this because you have a subscription with ${escapeHtml(vars.company)}. Card details are handled securely by Stripe.${pixel}</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;

  const text = `${fillText(template.body.replace(/\r\n/g, "\n").trim(), vars)}

${cta}: ${vars.update_link}

You're receiving this because you have a subscription with ${vars.company}. Card details are handled securely by Stripe.
`;

  return { subject, html, text };
}

/** Sample values for the dashboard preview. */
export function sampleVars(company: string): TemplateVars {
  return {
    customer_name: "Alex",
    amount: "$49.00",
    update_link: "https://example.com/u/sample-link",
    company: company || "Your company",
  };
}
