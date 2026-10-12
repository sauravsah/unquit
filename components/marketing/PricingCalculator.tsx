"use client";

import { motion } from "framer-motion";
import { Check } from "lucide-react";
import { useMemo, useState } from "react";
import { Reveal } from "@/components/motion";
import { cn } from "@/components/ui/cn";
import { NumberTicker } from "@/components/ui/number-ticker";
import { Slider } from "@/components/ui/slider";
import { formatCents } from "@/lib/pricing";
import { ASSUMED_RECOVERY_RATE, ASSUMED_SAVE_RATE, FLAT_FEE_TOOLS, MONTHLY_FEE_CAP_CENTS, estimateMonthlyFee } from "./estimate";

const ARPU_OPTIONS = [19, 49, 99, 249];
const usd = (n: number) => `$${n.toLocaleString("en-US")}`;

const PRICING = [
  { value: "$0", label: "base fee" },
  { value: "20%", label: "of saved MRR, first 3 months only" },
  { value: "10%", label: "of recovered failed payments" },
  { value: "$299", label: "monthly cap, ever" },
];

export function PricingCalculator() {
  const [mrr, setMrr] = useState(25_000);
  const [cancels, setCancels] = useState(20);
  const [failed, setFailed] = useState(15);
  const [arpu, setArpu] = useState(49);

  const e = useMemo(
    () => estimateMonthlyFee({ mrrDollars: mrr, cancelsPerMonth: cancels, failedPerMonth: failed, arpuDollars: arpu }),
    [mrr, cancels, failed, arpu],
  );
  const bars = [{ name: "unquit", monthlyCents: e.feeCents, ours: true }, ...FLAT_FEE_TOOLS.map((t) => ({ ...t, ours: false }))];
  const maxBar = Math.max(...bars.map((b) => b.monthlyCents), 1);

  return (
    <section id="pricing" className="container scroll-mt-24 py-24">
      <Reveal className="mx-auto max-w-2xl text-center">
        <p className="text-sm font-medium text-brand-text">Pricing</p>
        <h2 className="mt-3 text-4xl font-semibold tracking-tight text-foreground sm:text-5xl">Pricing that only moves when you win</h2>
        <p className="mt-4 text-lg text-muted-foreground">Flat-fee tools charge the same in a bad month. We charge a share of what we actually keep.</p>
      </Reveal>

      <dl className="mx-auto mt-10 grid max-w-4xl grid-cols-2 gap-3 sm:grid-cols-4">
        {PRICING.map((p, i) => (
          <Reveal key={p.label} delay={i * 0.05}>
            <div className="h-full rounded-2xl border border-border bg-card p-4 text-center shadow-card">
              <dt className="text-3xl font-semibold tracking-tight text-foreground">{p.value}</dt>
              <dd className="mt-1 text-xs text-muted-foreground">{p.label}</dd>
            </div>
          </Reveal>
        ))}
      </dl>

      <Reveal className="mt-10">
        <div className="ring-gradient relative grid overflow-hidden rounded-3xl border border-border bg-card shadow-float lg:grid-cols-[1.1fr_1fr]">
          <div className="space-y-7 p-6 sm:p-8">
            <h3 className="text-lg font-semibold text-foreground">Estimate your monthly fee</h3>
            <SliderRow label="Monthly recurring revenue" value={usd(mrr)} min={1_000} max={200_000} step={1_000} current={mrr} onChange={setMrr} />
            <SliderRow label="Cancellations per month" value={String(cancels)} min={0} max={300} step={1} current={cancels} onChange={setCancels} />
            <SliderRow label="Failed payments per month" value={String(failed)} min={0} max={300} step={1} current={failed} onChange={setFailed} />
            <div>
              <p id="arpu-label" className="text-sm font-medium text-foreground">
                Average plan price
              </p>
              <div role="radiogroup" aria-labelledby="arpu-label" className="mt-2.5 inline-flex rounded-xl border border-border bg-muted/60 p-1">
                {ARPU_OPTIONS.map((a) => (
                  <button
                    key={a}
                    type="button"
                    role="radio"
                    aria-checked={arpu === a}
                    onClick={() => setArpu(a)}
                    className={cn("relative rounded-lg px-3.5 py-1.5 text-sm font-medium transition-colors", arpu === a ? "text-foreground" : "text-muted-foreground hover:text-foreground")}
                  >
                    {arpu === a ? <motion.span layoutId="arpu-pill" className="absolute inset-0 rounded-lg border border-border bg-card shadow-xs" /> : null}
                    <span className="relative">${a}/mo</span>
                  </button>
                ))}
              </div>
            </div>
            <p className="text-xs leading-relaxed text-muted-foreground">
              Assumes the cancel flow keeps {Math.round(ASSUMED_SAVE_RATE * 100)}% of cancellations and emails recover{" "}
              {Math.round(ASSUMED_RECOVERY_RATE * 100)}% of failed payments. Steady-state month: each save earns 20% for its first 3 paid
              months, so three months of saves overlap.
            </p>
          </div>

          <div className="relative border-t border-border bg-surface p-6 sm:p-8 lg:border-l lg:border-t-0">
            <div aria-hidden="true" className="absolute right-0 top-0 h-48 w-48 rounded-full bg-brand/15 blur-3xl" />
            <div className="relative" aria-live="polite">
              <p className="text-sm text-muted-foreground">Your estimated unquit fee</p>
              <p className="mt-1 flex items-baseline gap-2">
                <span className="text-5xl font-semibold tracking-tight text-foreground">
                  <NumberTicker value={e.feeCents} format="cents" decimals={0} duration={0.5} />
                </span>
                <span className="text-sm text-muted-foreground">/ month</span>
              </p>
              <div className="mt-2 h-6">
                {e.capReached ? (
                  <motion.span initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} className="inline-flex items-center gap-1 rounded-full bg-brand-soft px-2 py-0.5 text-xs font-medium text-brand-text">
                    <Check className="h-3 w-3" /> Capped at {formatCents(MONTHLY_FEE_CAP_CENTS)}
                  </motion.span>
                ) : null}
              </div>

              <dl className="mt-4 grid grid-cols-2 gap-3 text-sm">
                <div className="rounded-xl border border-border bg-card p-3">
                  <dt className="text-xs text-muted-foreground">Revenue kept / mo</dt>
                  <dd className="mt-0.5 font-semibold text-brand-text">
                    <NumberTicker value={e.keptCents} format="cents" decimals={0} duration={0.5} />
                  </dd>
                </div>
                <div className="rounded-xl border border-border bg-card p-3">
                  <dt className="text-xs text-muted-foreground">After our fee</dt>
                  <dd className="mt-0.5 font-semibold text-foreground">
                    <NumberTicker value={e.netCents} format="cents" decimals={0} duration={0.5} />
                  </dd>
                </div>
              </dl>

              <p className="mt-6 text-xs font-medium uppercase tracking-wider text-muted-foreground">Versus flat-fee tools</p>
              <ul className="mt-3 space-y-2.5">
                {bars.map((b) => (
                  <li key={b.name} className="text-sm">
                    <div className="flex items-center justify-between">
                      <span className={cn(b.ours ? "font-semibold text-foreground" : "text-muted-foreground")}>{b.name}</span>
                      <span className={cn("tabular-nums", b.ours ? "font-semibold text-brand-text" : "text-muted-foreground")}>
                        {formatCents(b.monthlyCents).replace(/\.00$/, "")}
                        {b.ours ? "" : " flat"}
                      </span>
                    </div>
                    <div className="mt-1 h-2 overflow-hidden rounded-full bg-muted">
                      <motion.div
                        className={cn("h-full rounded-full", b.ours ? "bg-gradient-to-r from-brand to-brand-glow shadow-glow-sm" : "bg-zinc-400 dark:bg-zinc-600")}
                        initial={false}
                        animate={{ width: `${Math.max(2, (b.monthlyCents / maxBar) * 100)}%` }}
                        transition={{ type: "spring", stiffness: 160, damping: 24 }}
                      />
                    </div>
                  </li>
                ))}
              </ul>
              <p className="mt-4 text-2xs text-subtle">Flat-fee figures are for comparison and may not match each vendor&apos;s current pricing.</p>
            </div>
          </div>
        </div>
      </Reveal>
    </section>
  );
}

function SliderRow({
  label,
  value,
  min,
  max,
  step,
  current,
  onChange,
}: {
  label: string;
  value: string;
  min: number;
  max: number;
  step: number;
  current: number;
  onChange: (v: number) => void;
}) {
  return (
    <div>
      <div className="flex items-baseline justify-between">
        <span className="text-sm font-medium text-foreground">{label}</span>
        <span className="text-sm font-semibold tabular-nums text-foreground">{value}</span>
      </div>
      <Slider className="mt-3" min={min} max={max} step={step} value={[current]} onValueChange={(v) => onChange(v[0] ?? min)} thumbLabel={label} />
    </div>
  );
}
