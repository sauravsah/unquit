"use client";

import { useMemo, useRef, useState } from "react";
import { CATEGORY_LABELS, DECLINE_CATEGORIES, type DeclineCategory } from "@/lib/dunning/declines";
import { MAX_SCHEDULE_DAY } from "@/lib/dunning/schedule";
import type { DunningSettings } from "@/lib/dunning/settings";
import {
  DEFAULT_TEMPLATES,
  TEMPLATE_LIMITS,
  TEMPLATE_VARIABLES,
  renderEmail,
  sampleVars,
  type EmailTemplate,
} from "@/lib/dunning/templates";

const input =
  "rounded-lg border border-neutral-300 bg-white px-3 py-2 text-sm text-ink focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/30";

const CATEGORY_HELP: Record<DeclineCategory, string> = {
  soft: "Temporary problems like low funds. Stripe retries the card on its own, so these emails are gentle.",
  hard: "Expired, lost or blocked cards. Only a new card fixes it, so these ask for one.",
  authentication_required: "The bank wants the customer to approve the payment (3-D Secure). The page handles it.",
};

export function DunningEditor({
  initial,
  saved: initiallySaved,
  defaultCompany,
}: {
  initial: DunningSettings;
  saved: boolean;
  defaultCompany: string;
}) {
  const [settings, setSettings] = useState<DunningSettings>({ ...initial, companyName: initial.companyName ?? (defaultCompany || null) });
  const [days, setDays] = useState<string[]>(initial.scheduleDays.map(String));
  const [category, setCategory] = useState<DeclineCategory>("hard");
  const [step, setStep] = useState(0);
  const [status, setStatus] = useState<{ tone: "idle" | "saving" | "saved" | "error"; messages: string[] }>({
    tone: "idle",
    messages: initiallySaved ? [] : ["Emails are off until you add your company name, switch them on and save."],
  });
  const bodyRef = useRef<HTMLTextAreaElement | null>(null);

  const template = settings.templates[category][step]!;
  const isDefault =
    template.subject === DEFAULT_TEMPLATES[category][step]!.subject && template.body === DEFAULT_TEMPLATES[category][step]!.body;

  const preview = useMemo(
    () => renderEmail(template, sampleVars(settings.companyName ?? ""), { category }),
    [template, settings.companyName, category],
  );

  function update(patch: Partial<DunningSettings>) {
    setSettings((s) => ({ ...s, ...patch }));
    if (status.tone === "saved") setStatus({ tone: "idle", messages: [] });
  }

  function updateTemplate(patch: Partial<EmailTemplate>) {
    const list = settings.templates[category].map((t, i) => (i === step ? { ...t, ...patch } : t));
    update({ templates: { ...settings.templates, [category]: list } });
  }

  function insertVariable(name: string) {
    const el = bodyRef.current;
    const token = `{{${name}}}`;
    if (!el) return updateTemplate({ body: `${template.body}${token}` });
    const start = el.selectionStart ?? template.body.length;
    const end = el.selectionEnd ?? start;
    updateTemplate({ body: template.body.slice(0, start) + token + template.body.slice(end) });
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(start + token.length, start + token.length);
    });
  }

  async function save() {
    setStatus({ tone: "saving", messages: [] });
    const response = await fetch("/api/dunning/settings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...settings, scheduleDays: days.map((d) => Number(d)) }),
    });
    const json = (await response.json().catch(() => ({}))) as { errors?: string[]; settings?: DunningSettings };
    if (!response.ok || !json.settings) {
      setStatus({ tone: "error", messages: json.errors ?? ["Saving failed. Please try again."] });
      return;
    }
    setSettings(json.settings);
    setDays(json.settings.scheduleDays.map(String));
    setStatus({ tone: "saved", messages: ["Saved."] });
  }

  return (
    <div className="space-y-8">
      <section className="rounded-xl border border-neutral-200 bg-white p-5" aria-labelledby="dunning-settings">
        <h2 id="dunning-settings" className="text-base font-semibold text-ink">
          Settings
        </h2>
        <div className="mt-4 grid gap-6 md:grid-cols-2">
          <label className="flex items-start gap-3">
            <input
              type="checkbox"
              checked={settings.enabled}
              onChange={(e) => update({ enabled: e.target.checked })}
              className="mt-0.5 h-5 w-5 rounded border-neutral-300 accent-brand"
            />
            <span>
              <span className="block text-sm font-medium text-ink">Email customers when a payment fails</span>
              <span className="block text-xs text-neutral-500">Turn off any time. Open cases keep being tracked.</span>
            </span>
          </label>

          <div>
            <span className="block text-sm font-medium text-ink" id="schedule-label">
              Schedule (days after the failed payment)
            </span>
            <div className="mt-2 flex items-center gap-2" role="group" aria-labelledby="schedule-label">
              {days.map((d, i) => (
                <label key={i} className="flex items-center gap-1 text-xs text-neutral-500">
                  <span className="sr-only">Email {i + 1} on day</span>
                  <span aria-hidden="true">#{i + 1}</span>
                  <input
                    type="number"
                    min={0}
                    max={MAX_SCHEDULE_DAY}
                    inputMode="numeric"
                    value={d}
                    onChange={(e) => {
                      setDays(days.map((x, j) => (j === i ? e.target.value : x)));
                      if (status.tone === "saved") setStatus({ tone: "idle", messages: [] });
                    }}
                    className={`${input} w-20`}
                  />
                </label>
              ))}
            </div>
            <p className="mt-1 text-xs text-neutral-500">Default 0, 3, 7. Day 0 goes out as soon as the payment fails.</p>
          </div>

          <label className="block">
            <span className="block text-sm font-medium text-ink">Company name</span>
            <input
              type="text"
              value={settings.companyName ?? ""}
              maxLength={100}
              onChange={(e) => update({ companyName: e.target.value || null })}
              placeholder="Acme"
              className={`${input} mt-2 w-full`}
            />
            <span className="mt-1 block text-xs text-neutral-500">The sender name and the name on the card-update page.</span>
          </label>

          <label className="block">
            <span className="block text-sm font-medium text-ink">Reply-to email (optional)</span>
            <input
              type="email"
              value={settings.replyToEmail ?? ""}
              maxLength={254}
              onChange={(e) => update({ replyToEmail: e.target.value || null })}
              placeholder="help@acme.com"
              className={`${input} mt-2 w-full`}
            />
            <span className="mt-1 block text-xs text-neutral-500">Where customer replies go.</span>
          </label>
        </div>
      </section>

      <section className="rounded-xl border border-neutral-200 bg-white" aria-labelledby="dunning-templates">
        <div className="border-b border-neutral-200 px-5 py-4">
          <h2 id="dunning-templates" className="text-base font-semibold text-ink">
            Emails
          </h2>
          <p className="mt-1 text-sm text-neutral-500">Each type of decline gets its own 3 emails. Every email carries the card-update button.</p>
          <div className="mt-4 flex flex-wrap gap-2" role="tablist" aria-label="Decline type">
            {DECLINE_CATEGORIES.map((c) => (
              <button
                key={c}
                type="button"
                role="tab"
                aria-selected={c === category}
                onClick={() => setCategory(c)}
                className={`rounded-full px-3 py-1.5 text-sm font-medium ${
                  c === category ? "bg-ink text-white" : "bg-neutral-100 text-neutral-700 hover:bg-neutral-200"
                }`}
              >
                {CATEGORY_LABELS[c]}
              </button>
            ))}
          </div>
          <p className="mt-2 text-xs text-neutral-500">{CATEGORY_HELP[category]}</p>
        </div>

        <div className="grid gap-6 p-5 lg:grid-cols-2">
          <div className="space-y-4">
            <div className="flex gap-2" role="tablist" aria-label="Email in the sequence">
              {[0, 1, 2].map((i) => (
                <button
                  key={i}
                  type="button"
                  role="tab"
                  aria-selected={i === step}
                  onClick={() => setStep(i)}
                  className={`rounded-lg border px-3 py-1.5 text-sm ${
                    i === step ? "border-brand bg-brand-light font-medium text-ink" : "border-neutral-300 text-neutral-600 hover:border-neutral-400"
                  }`}
                >
                  Email {i + 1} · day {days[i] ?? "?"}
                </button>
              ))}
            </div>

            <label className="block">
              <span className="block text-sm font-medium text-ink">Subject</span>
              <input
                type="text"
                value={template.subject}
                maxLength={TEMPLATE_LIMITS.subject}
                onChange={(e) => updateTemplate({ subject: e.target.value })}
                className={`${input} mt-2 w-full`}
              />
            </label>

            <label className="block">
              <span className="block text-sm font-medium text-ink">Body</span>
              <textarea
                ref={bodyRef}
                value={template.body}
                maxLength={TEMPLATE_LIMITS.body}
                rows={14}
                onChange={(e) => updateTemplate({ body: e.target.value })}
                className={`${input} mt-2 w-full font-mono text-[13px] leading-relaxed`}
              />
              <span className="mt-1 block text-xs text-neutral-500">Leave a blank line between paragraphs.</span>
            </label>

            <div>
              <span className="block text-xs font-medium uppercase tracking-wide text-neutral-500">Insert a variable</span>
              <div className="mt-2 flex flex-wrap gap-2">
                {TEMPLATE_VARIABLES.map((v) => (
                  <button
                    key={v}
                    type="button"
                    onClick={() => insertVariable(v)}
                    className="rounded-md bg-neutral-100 px-2 py-1 font-mono text-xs text-ink hover:bg-neutral-200"
                  >
                    {`{{${v}}}`}
                  </button>
                ))}
              </div>
            </div>

            {!isDefault ? (
              <button
                type="button"
                onClick={() => updateTemplate({ ...DEFAULT_TEMPLATES[category][step]! })}
                className="text-xs font-medium text-neutral-600 underline underline-offset-2 hover:text-ink"
              >
                Reset this email to the default copy
              </button>
            ) : null}
          </div>

          <div>
            <span className="block text-sm font-medium text-ink">Preview</span>
            <p className="mt-1 truncate text-xs text-neutral-500">
              <span className="font-medium text-neutral-700">{settings.companyName || "Your company"}</span> · {preview.subject}
            </p>
            <iframe
              title="Email preview"
              srcDoc={preview.html}
              sandbox=""
              className="mt-2 h-[520px] w-full rounded-lg border border-neutral-200 bg-white"
            />
          </div>
        </div>
      </section>

      <div className="sticky bottom-0 -mx-6 flex flex-wrap items-center justify-between gap-3 border-t border-neutral-200 bg-white/95 px-6 py-4 backdrop-blur">
        <div aria-live="polite" className="text-sm">
          {status.messages.map((m) => (
            <p key={m} className={status.tone === "error" ? "text-red-700" : status.tone === "saved" ? "text-brand-dark" : "text-neutral-600"}>
              {m}
            </p>
          ))}
        </div>
        <button
          type="button"
          onClick={save}
          disabled={status.tone === "saving"}
          className="rounded-lg bg-brand px-5 py-2.5 text-sm font-semibold text-white hover:bg-brand-dark disabled:opacity-60"
        >
          {status.tone === "saving" ? "Saving…" : "Save settings and emails"}
        </button>
      </div>
    </div>
  );
}
