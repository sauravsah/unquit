"use client";

import { AnimatePresence, motion } from "framer-motion";
import { ArrowDown, ArrowUp, Monitor, Plus, RotateCcw, Smartphone, Trash2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/components/ui/cn";
import { Input, Kbd, NativeSelect } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { toast } from "@/components/ui/toast";
import { Tooltip } from "@/components/ui/tooltip";
import { describeOfferConfig } from "@/lib/flows/describe";
import type { PriceSnapshot } from "@/lib/flows/offers";
import { buildPreviewSession, createPreviewApi } from "@/lib/flows/preview";
import { LIMITS } from "@/lib/flows/schema";
import { TEMPLATES, applyTemplate } from "@/lib/flows/templates";
import { formatCents } from "@/lib/pricing";
import { mountFlow } from "@/widget/flow";
import type { FlowConfig, OfferConfig, OfferType, ReasonConfig } from "@/widget/types";

const OFFER_TYPES: { value: OfferType; label: string }[] = [
  { value: "discount", label: "Discount" },
  { value: "pause", label: "Pause" },
  { value: "downgrade", label: "Downgrade" },
  { value: "none", label: "No offer" },
];

function defaultOffer(type: OfferType, prices: readonly PriceSnapshot[]): OfferConfig {
  switch (type) {
    case "discount":
      return { type: "discount", percentOff: 25, months: 3 };
    case "pause":
      return { type: "pause", months: 1 };
    case "downgrade":
      return { type: "downgrade", priceId: prices[0]?.id ?? "" };
    case "none":
      return { type: "none" };
  }
}

function priceLabel(p: PriceSnapshot): string {
  const amount = p.unitAmountCents === null ? "?" : formatCents(p.unitAmountCents, p.currency);
  return `${p.productName} — ${amount}/${p.interval ?? "?"}`;
}

export function FlowEditor({
  initialFlow,
  saved: initiallySaved,
  prices,
}: {
  initialFlow: FlowConfig;
  saved: boolean;
  prices: PriceSnapshot[];
}) {
  const [flow, setFlow] = useState<FlowConfig>(initialFlow);
  const [status, setStatus] = useState<{ tone: "idle" | "saving" | "saved" | "error"; messages: string[] }>({
    tone: "idle",
    messages: initiallySaved ? [] : ["You're using the default flow. Save to make it yours."],
  });
  const [dirty, setDirty] = useState(false);
  const [previewLimited, setPreviewLimited] = useState(false);
  const [previewKey, setPreviewKey] = useState(0);
  const [device, setDevice] = useState<"desktop" | "mobile">("desktop");

  function update(next: FlowConfig) {
    setFlow(next);
    setDirty(true);
    if (status.tone === "saved") setStatus({ tone: "idle", messages: [] });
  }

  function updateReason(index: number, patch: Partial<ReasonConfig>, offerChanged = false) {
    const reasons = flow.reasons.map((r, i) => (i === index ? { ...r, ...patch } : r));
    update({ ...flow, reasons, template: offerChanged ? "custom" : flow.template });
  }

  function move(index: number, delta: number) {
    const target = index + delta;
    if (target < 0 || target >= flow.reasons.length) return;
    const reasons = [...flow.reasons];
    [reasons[index], reasons[target]] = [reasons[target]!, reasons[index]!];
    update({ ...flow, reasons });
  }

  function remove(index: number) {
    update({ ...flow, reasons: flow.reasons.filter((_, i) => i !== index) });
  }

  function add() {
    const id = `custom_${Date.now().toString(36)}`;
    update({ ...flow, template: "custom", reasons: [...flow.reasons, { id, label: "", offer: { type: "none" } }] });
  }

  function pickTemplate(id: (typeof TEMPLATES)[number]["id"]) {
    update({ ...flow, template: id, reasons: applyTemplate(id, flow.reasons) });
  }

  async function save() {
    setStatus({ tone: "saving", messages: [] });
    try {
      const res = await fetch("/api/flows", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(flow),
      });
      const data = (await res.json().catch(() => ({}))) as { errors?: string[]; flow?: FlowConfig };
      if (!res.ok) {
        setStatus({ tone: "error", messages: data.errors ?? ["Saving failed. Please try again."] });
        toast.error("Couldn't save the flow", { description: (data.errors ?? ["Please try again."]).join(" ") });
        return;
      }
      if (data.flow) setFlow(data.flow);
      setDirty(false);
      setStatus({ tone: "saved", messages: ["Saved. Your customers see this flow from now on."] });
      toast.success("Flow saved", { description: "Your customers see it from now on." });
    } catch {
      setStatus({ tone: "error", messages: ["We couldn't reach the server. Please try again."] });
      toast.error("We couldn't reach the server. Please try again.");
    }
  }

  // Warn before leaving with unsaved changes.
  useEffect(() => {
    if (!dirty) return;
    const handler = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [dirty]);

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
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,440px)]">
      <div className="space-y-6">
        <Card>
          <CardHeader>
            <div>
              <CardTitle>Start from a template</CardTitle>
              <CardDescription>Sets the offer for each built-in reason. You can tweak anything after.</CardDescription>
            </div>
            {flow.template === "custom" ? <Badge tone="info">Custom</Badge> : null}
          </CardHeader>
          <CardContent>
            <div className="grid gap-3 sm:grid-cols-3" role="radiogroup" aria-label="Template">
              {TEMPLATES.map((t) => {
                const active = flow.template === t.id;
                return (
                  <motion.button
                    key={t.id}
                    type="button"
                    role="radio"
                    aria-checked={active}
                    onClick={() => pickTemplate(t.id)}
                    whileHover={{ y: -2 }}
                    whileTap={{ scale: 0.98 }}
                    className={cn(
                      "relative rounded-xl border p-3.5 text-left text-sm transition-[border-color,box-shadow,background-color]",
                      active ? "border-brand bg-brand-soft/60 shadow-glow-sm" : "border-border bg-card hover:border-input",
                    )}
                  >
                    <span className="block font-semibold text-foreground">{t.name}</span>
                    <span className="mt-1 block text-xs text-muted-foreground">{t.description}</span>
                    {active ? <motion.span layoutId="template-dot" className="absolute right-3 top-3 h-2 w-2 rounded-full bg-brand shadow-glow-sm" /> : null}
                  </motion.button>
                );
              })}
            </div>
            {flow.template === "custom" ? (
              <p className="mt-3 text-xs text-muted-foreground">Custom: you&apos;ve changed the template&apos;s offers.</p>
            ) : null}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <div>
              <CardTitle>Reasons and offers</CardTitle>
              <CardDescription>What customers can pick, and what each reason is offered.</CardDescription>
            </div>
            <Badge tone="outline" className="tabular-nums">
              {flow.reasons.length}/{LIMITS.maxReasons}
            </Badge>
          </CardHeader>
          <CardContent>
            <ol className="space-y-3">
              <AnimatePresence initial={false}>
                {flow.reasons.map((reason, i) => (
                  <motion.li
                    key={reason.id}
                    layout
                    initial={{ opacity: 0, y: -8, scale: 0.98 }}
                    animate={{ opacity: 1, y: 0, scale: 1 }}
                    exit={{ opacity: 0, scale: 0.97, transition: { duration: 0.15 } }}
                    transition={{ type: "spring", stiffness: 420, damping: 34 }}
                    className="group rounded-xl border border-border bg-surface p-4 transition-colors hover:border-input"
                  >
                    <div className="flex flex-wrap items-end gap-3">
                      <span aria-hidden="true" className="mb-2 flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-muted text-2xs font-semibold text-muted-foreground">
                        {i + 1}
                      </span>
                      <label className="min-w-[12rem] flex-1 text-xs font-medium text-muted-foreground">
                        Reason {i + 1}
                        <Input
                          className="mt-1.5"
                          value={reason.label}
                          maxLength={LIMITS.maxLabel}
                          placeholder="e.g. Too expensive"
                          onChange={(e) => updateReason(i, { label: e.target.value })}
                        />
                      </label>
                      <label className="text-xs font-medium text-muted-foreground">
                        Offer
                        <span className="mt-1.5 block">
                          <NativeSelect
                            value={reason.offer.type}
                            onChange={(e) => updateReason(i, { offer: defaultOffer(e.target.value as OfferType, prices) }, true)}
                          >
                            {OFFER_TYPES.map((o) => (
                              <option key={o.value} value={o.value}>
                                {o.label}
                              </option>
                            ))}
                          </NativeSelect>
                        </span>
                      </label>
                      <div className="flex gap-1">
                        <IconButton label={`Move reason ${i + 1} up`} onClick={() => move(i, -1)} disabled={i === 0}>
                          <ArrowUp className="h-3.5 w-3.5" />
                        </IconButton>
                        <IconButton label={`Move reason ${i + 1} down`} onClick={() => move(i, 1)} disabled={i === flow.reasons.length - 1}>
                          <ArrowDown className="h-3.5 w-3.5" />
                        </IconButton>
                        <IconButton label={`Remove reason ${i + 1}`} onClick={() => remove(i)} disabled={flow.reasons.length <= 1} danger>
                          <Trash2 className="h-3.5 w-3.5" />
                        </IconButton>
                      </div>
                    </div>

                    <OfferParams offer={reason.offer} prices={prices} onChange={(offer) => updateReason(i, { offer }, true)} />

                    <label className="mt-3 flex cursor-pointer items-center gap-2.5 text-xs text-muted-foreground">
                      <Switch checked={reason.freeText === true} onCheckedChange={(v) => updateReason(i, { freeText: v })} />
                      Ask for more detail (free-text box)
                    </label>
                  </motion.li>
                ))}
              </AnimatePresence>
            </ol>
            <button
              type="button"
              onClick={add}
              disabled={flow.reasons.length >= LIMITS.maxReasons}
              className="mt-3 flex w-full items-center justify-center gap-1.5 rounded-xl border border-dashed border-input py-2.5 text-sm font-medium text-muted-foreground transition-colors hover:border-brand/50 hover:bg-brand-soft/40 hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
            >
              <Plus className="h-4 w-4" /> Add reason
            </button>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <div>
              <CardTitle>Settings</CardTitle>
              <CardDescription>What happens when a customer goes through with cancelling.</CardDescription>
            </div>
          </CardHeader>
          <CardContent className="space-y-6">
            <fieldset>
              <legend className="text-sm font-medium text-foreground">When a customer cancels</legend>
              <div className="mt-2.5 grid gap-2 sm:grid-cols-2">
                {(
                  [
                    { value: "period_end", label: "End of the paid period", hint: "Recommended" },
                    { value: "immediately", label: "Cancel immediately", hint: "Access ends now" },
                  ] as const
                ).map((opt) => {
                  const active = flow.cancelMode === opt.value;
                  return (
                    <label
                      key={opt.value}
                      className={cn(
                        "flex cursor-pointer items-center gap-3 rounded-xl border p-3 text-sm transition-[border-color,background-color]",
                        active ? "border-brand bg-brand-soft/50" : "border-border hover:border-input",
                      )}
                    >
                      <input
                        type="radio"
                        name="cancelMode"
                        className="h-4 w-4 accent-brand"
                        checked={active}
                        onChange={() => update({ ...flow, cancelMode: opt.value })}
                      />
                      <span>
                        <span className="block font-medium text-foreground">{opt.label}</span>
                        <span className="block text-xs text-muted-foreground">{opt.hint}</span>
                      </span>
                    </label>
                  );
                })}
              </div>
            </fieldset>
            <label className="block text-sm font-medium text-foreground">
              Offer limit
              <span className="mt-2 flex flex-wrap items-center gap-2 text-sm font-normal text-muted-foreground">
                One accepted offer per subscription every
                <Input
                  type="number"
                  className="w-24"
                  min={LIMITS.cooldownDays.min}
                  max={LIMITS.cooldownDays.max}
                  value={Number.isFinite(flow.offerCooldownDays) ? flow.offerCooldownDays : ""}
                  onChange={(e) => update({ ...flow, offerCooldownDays: e.target.valueAsNumber })}
                />
                days
              </span>
              <span className="mt-1.5 block text-xs font-normal text-muted-foreground">
                Stops customers from cancelling over and over for a new discount. 0 turns the limit off.
              </span>
            </label>
          </CardContent>
        </Card>

        {/* Sticky save bar */}
        <div className="glass sticky bottom-20 z-20 flex flex-wrap items-center gap-3 rounded-xl border p-3 shadow-lift md:bottom-4">
          <Button variant="brand" onClick={save} loading={status.tone === "saving"}>
            Save flow
          </Button>
          <AnimatePresence mode="wait">
            {dirty ? (
              <motion.span key="dirty" initial={{ opacity: 0, x: -4 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0 }} className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <span className="h-1.5 w-1.5 rounded-full bg-amber-500" /> Unsaved changes
              </motion.span>
            ) : null}
          </AnimatePresence>
          <span className="ml-auto hidden items-center gap-1 text-2xs text-muted-foreground sm:flex">
            <Kbd>⌘</Kbd>
            <Kbd>S</Kbd> to save
          </span>
          {status.messages.length > 0 ? (
            <div
              role={status.tone === "error" ? "alert" : "status"}
              className={cn("w-full text-sm", status.tone === "error" ? "text-danger" : status.tone === "saved" ? "text-brand-text" : "text-muted-foreground")}
            >
              {status.messages.map((m) => (
                <p key={m}>{m}</p>
              ))}
            </div>
          ) : null}
        </div>
      </div>

      <aside className="lg:sticky lg:top-20 lg:self-start">
        <Card className="overflow-hidden">
          <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-3">
            <div className="flex items-center gap-2">
              <span className="relative flex h-2 w-2">
                <span className="absolute inline-flex h-full w-full animate-pulse-ring rounded-full bg-brand" />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-brand" />
              </span>
              <h2 className="text-sm font-semibold text-foreground">Live preview</h2>
            </div>
            <div className="flex items-center gap-1">
              <div role="radiogroup" aria-label="Preview device" className="flex rounded-lg border border-border bg-muted/60 p-0.5">
                {(
                  [
                    { id: "desktop", icon: Monitor, label: "Desktop" },
                    { id: "mobile", icon: Smartphone, label: "Mobile" },
                  ] as const
                ).map(({ id, icon: Icon, label }) => (
                  <Tooltip key={id} content={label}>
                    <button
                      type="button"
                      role="radio"
                      aria-checked={device === id}
                      aria-label={label}
                      onClick={() => setDevice(id)}
                      className={cn(
                        "relative flex h-7 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors",
                        device === id && "text-foreground",
                      )}
                    >
                      {device === id ? (
                        <motion.span layoutId="device-pill" className="absolute inset-0 rounded-md border border-border bg-card shadow-xs" />
                      ) : null}
                      <Icon className="relative h-3.5 w-3.5" />
                    </button>
                  </Tooltip>
                ))}
              </div>
              <Tooltip content="Restart preview">
                <Button variant="ghost" size="icon-sm" onClick={() => setPreviewKey((k) => k + 1)} aria-label="Restart preview">
                  <RotateCcw className="h-3.5 w-3.5" />
                </Button>
              </Tooltip>
            </div>
          </div>

          <div className="bg-grid relative flex justify-center bg-surface px-3 py-6">
            <DeviceFrame device={device}>
              <Preview flow={flow} prices={prices} offersEnabled={!previewLimited} restartKey={previewKey} />
            </DeviceFrame>
          </div>

          <div className="space-y-3 border-t border-border px-4 py-3">
            <label className="flex cursor-pointer items-center gap-2.5 text-xs text-muted-foreground">
              <Switch checked={previewLimited} onCheckedChange={setPreviewLimited} />
              Preview as a customer who already used an offer
            </label>
            <p className="text-xs text-muted-foreground">Sample customer on a {formatCents(99_900)}/mo plan. Nothing here touches Stripe.</p>
            <ul className="space-y-1 text-xs">
              {flow.reasons.map((r) => (
                <li key={r.id} className="flex items-center gap-2 text-muted-foreground">
                  <span className="truncate text-foreground">{r.label || "(no label)"}</span>
                  <span className="text-subtle">→</span>
                  <span className="truncate">{describeOfferConfig(r.offer)}</span>
                </li>
              ))}
            </ul>
          </div>
        </Card>
      </aside>
    </div>
  );
}

/** Browser window or phone around the preview. Width animates between the two. */
function DeviceFrame({ device, children }: { device: "desktop" | "mobile"; children: React.ReactNode }) {
  const mobile = device === "mobile";
  return (
    <motion.div
      layout
      transition={{ type: "spring", stiffness: 260, damping: 30 }}
      className={cn(
        "relative w-full overflow-hidden bg-background shadow-float",
        mobile ? "max-w-[300px] rounded-[2.2rem] border-[7px] border-zinc-900 dark:border-zinc-700" : "rounded-xl border border-border",
      )}
    >
      {mobile ? (
        <div aria-hidden="true" className="flex h-7 items-center justify-center bg-background">
          <span className="h-4 w-20 rounded-full bg-zinc-900 dark:bg-zinc-700" />
        </div>
      ) : (
        <div aria-hidden="true" className="flex h-8 items-center gap-1.5 border-b border-border bg-muted/60 px-3">
          <span className="h-2.5 w-2.5 rounded-full bg-[#FF5F57]" />
          <span className="h-2.5 w-2.5 rounded-full bg-[#FEBC2E]" />
          <span className="h-2.5 w-2.5 rounded-full bg-[#28C840]" />
          <span className="ml-3 h-4 flex-1 rounded-md bg-background/80 text-center text-[10px] leading-4 text-subtle">yourapp.com/settings/billing</span>
        </div>
      )}
      <div className={cn("overflow-y-auto", mobile ? "max-h-[540px]" : "max-h-[560px]")}>{children}</div>
      {mobile ? <div aria-hidden="true" className="mx-auto my-2 h-1 w-24 rounded-full bg-foreground/20" /> : null}
    </motion.div>
  );
}

function IconButton({
  label,
  onClick,
  disabled,
  danger,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
  children: React.ReactNode;
}) {
  return (
    <Tooltip content={label}>
      <button
        type="button"
        aria-label={label}
        onClick={onClick}
        disabled={disabled}
        className={cn(
          "flex h-9 w-9 items-center justify-center rounded-lg border border-border bg-card text-muted-foreground transition-[color,border-color,transform] active:scale-95 disabled:pointer-events-none disabled:opacity-40",
          danger ? "hover:border-danger/40 hover:text-danger" : "hover:border-input hover:text-foreground",
        )}
      >
        {children}
      </button>
    </Tooltip>
  );
}

function OfferParams({
  offer,
  prices,
  onChange,
}: {
  offer: OfferConfig;
  prices: PriceSnapshot[];
  onChange: (offer: OfferConfig) => void;
}) {
  const num = (v: number) => (Number.isFinite(v) ? v : 0);
  switch (offer.type) {
    case "discount":
      return (
        <div className="mt-3 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
          <Input
            type="number"
            aria-label="Percent off"
            className="w-20"
            min={LIMITS.discountPercent.min}
            max={LIMITS.discountPercent.max}
            value={offer.percentOff}
            onChange={(e) => onChange({ ...offer, percentOff: num(e.target.valueAsNumber) })}
          />
          % off for
          <Input
            type="number"
            aria-label="Number of months"
            className="w-20"
            min={LIMITS.discountMonths.min}
            max={LIMITS.discountMonths.max}
            value={offer.months}
            onChange={(e) => onChange({ ...offer, months: num(e.target.valueAsNumber) })}
          />
          months
        </div>
      );
    case "pause":
      return (
        <div className="mt-3 flex items-center gap-2 text-sm text-muted-foreground">
          Pause billing for
          <NativeSelect aria-label="Pause length" value={offer.months} onChange={(e) => onChange({ type: "pause", months: Number(e.target.value) })}>
            {[1, 2, 3].map((m) => (
              <option key={m} value={m}>
                {m} month{m === 1 ? "" : "s"}
              </option>
            ))}
          </NativeSelect>
        </div>
      );
    case "downgrade":
      return (
        <div className="mt-3 text-sm text-muted-foreground">
          {prices.length > 0 ? (
            <label className="flex flex-wrap items-center gap-2">
              Move them to
              <NativeSelect className="max-w-full" value={offer.priceId} onChange={(e) => onChange({ type: "downgrade", priceId: e.target.value })}>
                {prices.some((p) => p.id === offer.priceId) ? null : <option value={offer.priceId}>{offer.priceId || "Pick a price"}</option>}
                {prices.map((p) => (
                  <option key={p.id} value={p.id}>
                    {priceLabel(p)}
                  </option>
                ))}
              </NativeSelect>
            </label>
          ) : (
            <label className="flex flex-wrap items-center gap-2">
              Stripe price id
              <Input
                className="w-64 font-mono"
                placeholder="price_…"
                value={offer.priceId}
                onChange={(e) => onChange({ type: "downgrade", priceId: e.target.value.trim() })}
              />
            </label>
          )}
          <p className="mt-1 text-xs text-muted-foreground">Only shown when the customer is on a pricier single-item plan.</p>
        </div>
      );
    case "none":
      return <p className="mt-3 text-xs text-muted-foreground">No offer: this reason goes straight to the cancel confirmation.</p>;
  }
}

/** Mounts the real widget flow (inline mode) and re-mounts it when the config changes. */
function Preview({
  flow,
  prices,
  offersEnabled,
  restartKey,
}: {
  flow: FlowConfig;
  prices: PriceSnapshot[];
  offersEnabled: boolean;
  restartKey: number;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const session = useMemo(() => buildPreviewSession(flow, prices, { offersEnabled, now: new Date() }), [flow, prices, offersEnabled]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let disposed = false;
    let current: { close: () => void } | null = null;
    let restart: ReturnType<typeof setTimeout> | undefined;
    const start = (delayMs: number) => {
      current = mountFlow(host, {
        mode: "inline",
        api: createPreviewApi(session, delayMs),
        // "Done", "Never mind" etc. in the preview just start it over.
        onClose: () => {
          if (!disposed) restart = setTimeout(() => start(0), 600);
        },
      });
    };
    const timer = setTimeout(() => start(350), 150);
    return () => {
      disposed = true;
      clearTimeout(timer);
      clearTimeout(restart);
      current?.close();
    };
  }, [session, restartKey]);

  return <div ref={hostRef} aria-label="Cancel flow preview" />;
}
