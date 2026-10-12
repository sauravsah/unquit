"use client";

import { useEffect, useMemo, useRef, useState } from "react";
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

const input =
  "rounded-lg border border-neutral-300 bg-white px-3 py-2 text-sm text-ink focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/30";

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
        return;
      }
      if (data.flow) setFlow(data.flow);
      setDirty(false);
      setStatus({ tone: "saved", messages: ["Saved. Your customers see this flow from now on."] });
    } catch {
      setStatus({ tone: "error", messages: ["We couldn't reach the server. Please try again."] });
    }
  }

  // Warn before leaving with unsaved changes.
  useEffect(() => {
    if (!dirty) return;
    const handler = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [dirty]);

  return (
    <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_420px]">
      <div className="space-y-6">
        <section className="rounded-xl border border-neutral-200 bg-white p-5">
          <h2 className="text-base font-semibold text-ink">Start from a template</h2>
          <p className="mt-1 text-sm text-neutral-500">Sets the offer for each built-in reason. You can tweak anything after.</p>
          <div className="mt-4 grid gap-3 sm:grid-cols-3" role="radiogroup" aria-label="Template">
            {TEMPLATES.map((t) => {
              const active = flow.template === t.id;
              return (
                <button
                  key={t.id}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  onClick={() => pickTemplate(t.id)}
                  className={`rounded-lg border p-3 text-left text-sm transition ${
                    active ? "border-brand bg-brand-light/50" : "border-neutral-200 hover:border-neutral-400"
                  }`}
                >
                  <span className="block font-semibold text-ink">{t.name}</span>
                  <span className="mt-1 block text-xs text-neutral-500">{t.description}</span>
                </button>
              );
            })}
          </div>
          {flow.template === "custom" ? <p className="mt-3 text-xs text-neutral-500">Custom: you&apos;ve changed the template&apos;s offers.</p> : null}
        </section>

        <section className="rounded-xl border border-neutral-200 bg-white p-5">
          <div className="flex items-center justify-between">
            <h2 className="text-base font-semibold text-ink">Reasons and offers</h2>
            <span className="text-xs text-neutral-500">
              {flow.reasons.length}/{LIMITS.maxReasons}
            </span>
          </div>
          <ol className="mt-4 space-y-3">
            {flow.reasons.map((reason, i) => (
              <li key={reason.id} className="rounded-lg border border-neutral-200 p-4">
                <div className="flex flex-wrap items-end gap-3">
                  <label className="min-w-[12rem] flex-1 text-xs font-medium text-neutral-600">
                    Reason {i + 1}
                    <input
                      className={`${input} mt-1 block w-full`}
                      value={reason.label}
                      maxLength={LIMITS.maxLabel}
                      placeholder="e.g. Too expensive"
                      onChange={(e) => updateReason(i, { label: e.target.value })}
                    />
                  </label>
                  <label className="text-xs font-medium text-neutral-600">
                    Offer
                    <select
                      className={`${input} mt-1 block`}
                      value={reason.offer.type}
                      onChange={(e) => updateReason(i, { offer: defaultOffer(e.target.value as OfferType, prices) }, true)}
                    >
                      {OFFER_TYPES.map((o) => (
                        <option key={o.value} value={o.value}>
                          {o.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <div className="flex gap-1">
                    <IconButton label={`Move reason ${i + 1} up`} onClick={() => move(i, -1)} disabled={i === 0}>
                      ↑
                    </IconButton>
                    <IconButton
                      label={`Move reason ${i + 1} down`}
                      onClick={() => move(i, 1)}
                      disabled={i === flow.reasons.length - 1}
                    >
                      ↓
                    </IconButton>
                    <IconButton label={`Remove reason ${i + 1}`} onClick={() => remove(i)} disabled={flow.reasons.length <= 1}>
                      ×
                    </IconButton>
                  </div>
                </div>

                <OfferParams offer={reason.offer} prices={prices} onChange={(offer) => updateReason(i, { offer }, true)} />

                <label className="mt-3 flex items-center gap-2 text-xs text-neutral-600">
                  <input
                    type="checkbox"
                    className="accent-brand"
                    checked={reason.freeText === true}
                    onChange={(e) => updateReason(i, { freeText: e.target.checked })}
                  />
                  Ask for more detail (free-text box)
                </label>
              </li>
            ))}
          </ol>
          <button
            type="button"
            onClick={add}
            disabled={flow.reasons.length >= LIMITS.maxReasons}
            className="mt-3 rounded-lg border border-dashed border-neutral-300 px-3 py-2 text-sm font-medium text-neutral-700 hover:border-neutral-400 disabled:opacity-50"
          >
            + Add reason
          </button>
        </section>

        <section className="rounded-xl border border-neutral-200 bg-white p-5">
          <h2 className="text-base font-semibold text-ink">Settings</h2>
          <fieldset className="mt-4">
            <legend className="text-sm font-medium text-ink">When a customer cancels</legend>
            <div className="mt-2 space-y-2 text-sm text-neutral-700">
              <label className="flex items-center gap-2">
                <input
                  type="radio"
                  name="cancelMode"
                  className="accent-brand"
                  checked={flow.cancelMode === "period_end"}
                  onChange={() => update({ ...flow, cancelMode: "period_end" })}
                />
                End at the close of the paid period (recommended)
              </label>
              <label className="flex items-center gap-2">
                <input
                  type="radio"
                  name="cancelMode"
                  className="accent-brand"
                  checked={flow.cancelMode === "immediately"}
                  onChange={() => update({ ...flow, cancelMode: "immediately" })}
                />
                Cancel immediately
              </label>
            </div>
          </fieldset>
          <label className="mt-5 block text-sm font-medium text-ink">
            Offer limit
            <span className="mt-1 flex items-center gap-2 text-sm font-normal text-neutral-700">
              One accepted offer per subscription every
              <input
                type="number"
                className={`${input} w-24`}
                min={LIMITS.cooldownDays.min}
                max={LIMITS.cooldownDays.max}
                value={Number.isFinite(flow.offerCooldownDays) ? flow.offerCooldownDays : ""}
                onChange={(e) => update({ ...flow, offerCooldownDays: e.target.valueAsNumber })}
              />
              days
            </span>
            <span className="mt-1 block text-xs font-normal text-neutral-500">
              Stops customers from cancelling over and over for a new discount. 0 turns the limit off.
            </span>
          </label>
        </section>

        <div className="flex flex-wrap items-center gap-4">
          <button
            type="button"
            onClick={save}
            disabled={status.tone === "saving"}
            className="rounded-lg bg-brand px-5 py-2.5 text-sm font-semibold text-white hover:bg-brand-dark disabled:opacity-60"
          >
            {status.tone === "saving" ? "Saving…" : "Save flow"}
          </button>
          {dirty ? <span className="text-xs text-neutral-500">Unsaved changes</span> : null}
        </div>
        {status.messages.length > 0 ? (
          <div
            role={status.tone === "error" ? "alert" : "status"}
            className={`rounded-lg border px-4 py-3 text-sm ${
              status.tone === "error" ? "border-red-200 bg-red-50 text-red-800" : "border-neutral-200 bg-white text-neutral-700"
            }`}
          >
            {status.messages.map((m) => (
              <p key={m}>{m}</p>
            ))}
          </div>
        ) : null}
      </div>

      <aside className="lg:sticky lg:top-6 lg:self-start">
        <div className="flex items-center justify-between">
          <h2 className="text-base font-semibold text-ink">Live preview</h2>
          <button
            type="button"
            onClick={() => setPreviewKey((k) => k + 1)}
            className="text-xs font-medium text-brand hover:text-brand-dark"
          >
            Restart preview
          </button>
        </div>
        <label className="mt-2 flex items-center gap-2 text-xs text-neutral-600">
          <input
            type="checkbox"
            className="accent-brand"
            checked={previewLimited}
            onChange={(e) => setPreviewLimited(e.target.checked)}
          />
          Preview as a customer who already used an offer
        </label>
        <div className="mt-3">
          <Preview flow={flow} prices={prices} offersEnabled={!previewLimited} restartKey={previewKey} />
        </div>
        <p className="mt-2 text-xs text-neutral-500">
          Sample customer on a {formatCents(99_900)}/mo plan. Nothing here touches Stripe.
        </p>
        <ul className="mt-3 space-y-1 text-xs text-neutral-500">
          {flow.reasons.map((r) => (
            <li key={r.id}>
              <span className="text-neutral-700">{r.label || "(no label)"}</span> → {describeOfferConfig(r.offer)}
            </li>
          ))}
        </ul>
      </aside>
    </div>
  );
}

function IconButton({
  label,
  onClick,
  disabled,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      disabled={disabled}
      className="h-9 w-9 rounded-lg border border-neutral-200 text-sm text-neutral-600 hover:border-neutral-400 hover:text-ink disabled:opacity-40"
    >
      {children}
    </button>
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
        <div className="mt-3 flex flex-wrap items-center gap-2 text-sm text-neutral-700">
          <input
            type="number"
            aria-label="Percent off"
            className={`${input} w-20`}
            min={LIMITS.discountPercent.min}
            max={LIMITS.discountPercent.max}
            value={offer.percentOff}
            onChange={(e) => onChange({ ...offer, percentOff: num(e.target.valueAsNumber) })}
          />
          % off for
          <input
            type="number"
            aria-label="Number of months"
            className={`${input} w-20`}
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
        <div className="mt-3 flex items-center gap-2 text-sm text-neutral-700">
          Pause billing for
          <select
            aria-label="Pause length"
            className={input}
            value={offer.months}
            onChange={(e) => onChange({ type: "pause", months: Number(e.target.value) })}
          >
            {[1, 2, 3].map((m) => (
              <option key={m} value={m}>
                {m} month{m === 1 ? "" : "s"}
              </option>
            ))}
          </select>
        </div>
      );
    case "downgrade":
      return (
        <div className="mt-3 text-sm text-neutral-700">
          {prices.length > 0 ? (
            <label className="flex flex-wrap items-center gap-2">
              Move them to
              <select
                className={`${input} max-w-full`}
                value={offer.priceId}
                onChange={(e) => onChange({ type: "downgrade", priceId: e.target.value })}
              >
                {prices.some((p) => p.id === offer.priceId) ? null : <option value={offer.priceId}>{offer.priceId || "Pick a price"}</option>}
                {prices.map((p) => (
                  <option key={p.id} value={p.id}>
                    {priceLabel(p)}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <label className="flex flex-wrap items-center gap-2">
              Stripe price id
              <input
                className={`${input} w-64 font-mono`}
                placeholder="price_…"
                value={offer.priceId}
                onChange={(e) => onChange({ type: "downgrade", priceId: e.target.value.trim() })}
              />
            </label>
          )}
          <p className="mt-1 text-xs text-neutral-500">Only shown when the customer is on a pricier single-item plan.</p>
        </div>
      );
    case "none":
      return <p className="mt-3 text-xs text-neutral-500">No offer: this reason goes straight to the cancel confirmation.</p>;
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
