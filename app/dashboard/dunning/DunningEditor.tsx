"use client";

import { AnimatePresence, motion } from "framer-motion";
import { Mail, RotateCcw } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/components/ui/cn";
import { Field, Input, Kbd, Textarea } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { toast } from "@/components/ui/toast";
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
  const [toggling, setToggling] = useState(false);
  const bodyRef = useRef<HTMLTextAreaElement | null>(null);
  /** What the server has: the on/off switch saves against this, not the unsaved draft. */
  const savedRef = useRef<DunningSettings | null>(initiallySaved ? initial : null);

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
      toast.error("Couldn't save", { description: (json.errors ?? ["Please try again."]).join(" ") });
      return;
    }
    savedRef.current = json.settings;
    setSettings(json.settings);
    setDays(json.settings.scheduleDays.map(String));
    setStatus({ tone: "saved", messages: ["Saved."] });
    toast.success("Settings and emails saved");
  }

  /**
   * Optimistic on/off: flips at once and saves just that change on top of the
   * last saved settings (the first time, the draft). Rolls back on error.
   */
  async function toggleEnabled(next: boolean) {
    const previous = settings.enabled;
    setSettings((s) => ({ ...s, enabled: next }));
    setToggling(true);
    const base = savedRef.current ?? { ...settings, scheduleDays: days.map((d) => Number(d)) as unknown as DunningSettings["scheduleDays"] };
    try {
      const response = await fetch("/api/dunning/settings", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...base, enabled: next }),
      });
      const json = (await response.json().catch(() => ({}))) as { errors?: string[]; settings?: DunningSettings };
      if (!response.ok || !json.settings) throw new Error(json.errors?.join(" ") ?? "Saving failed. Please try again.");
      savedRef.current = json.settings;
      toast.success(next ? "Failed-payment emails are on" : "Failed-payment emails are off");
    } catch (err) {
      setSettings((s) => ({ ...s, enabled: previous }));
      toast.error(err instanceof Error ? err.message : "Saving failed. Please try again.");
    } finally {
      setToggling(false);
    }
  }

  // ⌘S / Ctrl+S saves.
  const saveRef = useRef(save);
  saveRef.current = save;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        void saveRef.current();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="space-y-6">
      <Card aria-labelledby="dunning-settings">
        <CardHeader>
          <div>
            <CardTitle id="dunning-settings">Settings</CardTitle>
            <CardDescription>Who the emails come from and when they go out.</CardDescription>
          </div>
        </CardHeader>
        <CardContent className="grid gap-6 md:grid-cols-2">
          <div
            className={cn(
              "flex items-start justify-between gap-4 rounded-xl border p-4 transition-[border-color,background-color] md:col-span-2",
              settings.enabled ? "border-brand/40 bg-brand-soft/50" : "border-border bg-surface",
            )}
          >
            <div className="flex items-start gap-3">
              <span className={cn("mt-0.5 flex h-8 w-8 items-center justify-center rounded-lg border", settings.enabled ? "border-brand/30 bg-brand/10" : "border-border bg-muted")}>
                <Mail className={cn("h-4 w-4", settings.enabled ? "text-brand-text" : "text-muted-foreground")} />
              </span>
              <div>
                <p id="enabled-label" className="text-sm font-medium text-foreground">
                  Email customers when a payment fails
                </p>
                <p className="mt-0.5 text-xs text-muted-foreground">Saved instantly. Turn off any time; open cases keep being tracked.</p>
              </div>
            </div>
            <Switch checked={settings.enabled} onCheckedChange={(v) => void toggleEnabled(v)} disabled={toggling} aria-labelledby="enabled-label" />
          </div>

          <div>
            <span className="block text-sm font-medium text-foreground" id="schedule-label">
              Schedule (days after the failed payment)
            </span>
            <div className="mt-2 flex items-center gap-2" role="group" aria-labelledby="schedule-label">
              {days.map((d, i) => (
                <label key={i} className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <span className="sr-only">Email {i + 1} on day</span>
                  <span aria-hidden="true" className="flex h-5 w-5 items-center justify-center rounded bg-muted text-2xs font-semibold">
                    {i + 1}
                  </span>
                  <Input
                    type="number"
                    min={0}
                    max={MAX_SCHEDULE_DAY}
                    inputMode="numeric"
                    value={d}
                    onChange={(e) => {
                      setDays(days.map((x, j) => (j === i ? e.target.value : x)));
                      if (status.tone === "saved") setStatus({ tone: "idle", messages: [] });
                    }}
                    className="w-16"
                  />
                </label>
              ))}
            </div>
            <p className="mt-1.5 text-xs text-muted-foreground">Default 0, 3, 7. Day 0 goes out as soon as the payment fails.</p>
          </div>

          <div aria-hidden="true" className="hidden md:block" />

          <Field label="Company name" hint="The sender name and the name on the card-update page.">
            <Input
              type="text"
              value={settings.companyName ?? ""}
              maxLength={100}
              onChange={(e) => update({ companyName: e.target.value || null })}
              placeholder="Acme"
            />
          </Field>

          <Field label="Reply-to email (optional)" hint="Where customer replies go.">
            <Input
              type="email"
              value={settings.replyToEmail ?? ""}
              maxLength={254}
              onChange={(e) => update({ replyToEmail: e.target.value || null })}
              placeholder="help@acme.com"
            />
          </Field>
        </CardContent>
      </Card>

      <Card aria-labelledby="dunning-templates">
        <Tabs value={category} onValueChange={(v) => setCategory(v as DeclineCategory)} variant="pill">
          <CardHeader className="flex-col items-stretch">
            <div>
              <CardTitle id="dunning-templates">Emails</CardTitle>
              <CardDescription>Each type of decline gets its own 3 emails. Every email carries the card-update button.</CardDescription>
            </div>
            <TabsList aria-label="Decline type" className="mt-2 self-start">
              {DECLINE_CATEGORIES.map((c) => (
                <TabsTrigger key={c} value={c}>
                  {CATEGORY_LABELS[c]}
                </TabsTrigger>
              ))}
            </TabsList>
            <p className="text-xs text-muted-foreground">{CATEGORY_HELP[category]}</p>
          </CardHeader>

          <TabsContent value={category} className="mt-0">
            <div className="grid gap-6 p-5 lg:grid-cols-2">
              <Tabs value={String(step)} onValueChange={(v) => setStep(Number(v))}>
                <TabsList aria-label="Email in the sequence">
                  {[0, 1, 2].map((i) => (
                    <TabsTrigger key={i} value={String(i)}>
                      Email {i + 1}
                      <span className="text-2xs font-normal text-muted-foreground">day {days[i] ?? "?"}</span>
                    </TabsTrigger>
                  ))}
                </TabsList>
                <TabsContent value={String(step)} className="space-y-4">
                  <Field label="Subject">
                    <Input
                      type="text"
                      value={template.subject}
                      maxLength={TEMPLATE_LIMITS.subject}
                      onChange={(e) => updateTemplate({ subject: e.target.value })}
                    />
                  </Field>

                  <Field label="Body" hint="Leave a blank line between paragraphs.">
                    <Textarea
                      ref={bodyRef}
                      value={template.body}
                      maxLength={TEMPLATE_LIMITS.body}
                      rows={14}
                      onChange={(e) => updateTemplate({ body: e.target.value })}
                      className="font-mono text-[13px]"
                    />
                  </Field>

                  <div>
                    <span className="block text-2xs font-medium uppercase tracking-wider text-muted-foreground">Insert a variable</span>
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {TEMPLATE_VARIABLES.map((v) => (
                        <button
                          key={v}
                          type="button"
                          onClick={() => insertVariable(v)}
                          className="rounded-md border border-border bg-muted px-2 py-1 font-mono text-xs text-foreground transition-[background-color,border-color,transform] hover:border-brand/40 hover:bg-brand-soft active:scale-95"
                        >
                          {`{{${v}}}`}
                        </button>
                      ))}
                    </div>
                  </div>

                  {!isDefault ? (
                    <Button variant="ghost" size="sm" onClick={() => updateTemplate({ ...DEFAULT_TEMPLATES[category][step]! })}>
                      <RotateCcw className="h-3.5 w-3.5" /> Reset this email to the default copy
                    </Button>
                  ) : null}
                </TabsContent>
              </Tabs>

              <div>
                <span className="block text-sm font-medium text-foreground">Preview</span>
                <div className="mt-2 overflow-hidden rounded-xl border border-border bg-card shadow-lift">
                  <div className="space-y-1 border-b border-border bg-muted/50 px-4 py-3 text-xs">
                    <p className="flex gap-2">
                      <span className="w-12 shrink-0 text-muted-foreground">From</span>
                      <span className="font-medium text-foreground">{settings.companyName || "Your company"}</span>
                    </p>
                    <p className="flex gap-2">
                      <span className="w-12 shrink-0 text-muted-foreground">Subject</span>
                      <span className="truncate text-foreground">{preview.subject}</span>
                    </p>
                  </div>
                  {/* Email HTML is always light, like most inboxes render it. */}
                  <iframe title="Email preview" srcDoc={preview.html} sandbox="" className="h-[520px] w-full bg-white" />
                </div>
              </div>
            </div>
          </TabsContent>
        </Tabs>
      </Card>

      <div className="glass sticky bottom-20 z-20 flex flex-wrap items-center justify-between gap-3 rounded-xl border p-3 shadow-lift md:bottom-4">
        <div aria-live="polite" className="min-h-[20px] text-sm">
          <AnimatePresence mode="wait">
            {status.messages.map((m) => (
              <motion.p
                key={m}
                initial={{ opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0 }}
                className={status.tone === "error" ? "text-danger" : status.tone === "saved" ? "text-brand-text" : "text-muted-foreground"}
              >
                {m}
              </motion.p>
            ))}
          </AnimatePresence>
        </div>
        <div className="flex items-center gap-3">
          <span className="hidden items-center gap-1 text-2xs text-muted-foreground sm:flex">
            <Kbd>⌘</Kbd>
            <Kbd>S</Kbd>
          </span>
          {settings.enabled ? <Badge tone="success" dot="pulse">Emails on</Badge> : <Badge dot>Emails off</Badge>}
          <Button variant="brand" onClick={save} loading={status.tone === "saving"}>
            Save settings and emails
          </Button>
        </div>
      </div>
    </div>
  );
}
