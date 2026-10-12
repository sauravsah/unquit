"use client";

import { motion } from "framer-motion";
import { ArrowDownRight, ArrowUpRight, Minus } from "lucide-react";
import { cn } from "./cn";
import { NumberTicker, type NumberFormat } from "./number-ticker";
import { Tooltip } from "./tooltip";

/**
 * A KPI tile: label, animated value, delta chip and an optional visual
 * (e.g. a radial progress) on the right. Pass `value` + `format` to animate,
 * or `display` for a pre-formatted string.
 */
export function StatCard({
  label,
  value,
  format = "integer",
  currency,
  display,
  hint,
  delta,
  deltaLabel = "vs last month",
  invertDelta = false,
  icon,
  emphasis = false,
  aside,
  className,
}: {
  label: string;
  value?: number | null;
  format?: NumberFormat;
  currency?: string;
  display?: string;
  hint?: React.ReactNode;
  /** Change as a fraction (0.12 = +12%). null/undefined hides the chip. */
  delta?: number | null;
  deltaLabel?: string;
  /** For metrics where down is good (e.g. MRR at risk). */
  invertDelta?: boolean;
  icon?: React.ReactNode;
  emphasis?: boolean;
  aside?: React.ReactNode;
  className?: string;
}) {
  return (
    <motion.div
      whileHover={{ y: -2 }}
      transition={{ type: "spring", stiffness: 400, damping: 30 }}
      className={cn(
        "group relative overflow-hidden rounded-xl border border-border bg-card p-5 shadow-card transition-shadow duration-200 hover:shadow-lift",
        emphasis && "ring-gradient",
        className,
      )}
    >
      {emphasis ? (
        <div aria-hidden="true" className="pointer-events-none absolute -right-10 -top-10 h-32 w-32 rounded-full bg-brand/15 blur-3xl" />
      ) : null}
      <div className="relative flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
            {icon ? <span className="text-subtle [&_svg]:h-3.5 [&_svg]:w-3.5">{icon}</span> : null}
            {label}
          </p>
          <p className={cn("mt-2 text-2xl font-semibold tracking-tight", emphasis ? "text-brand-text" : "text-foreground")}>
            {display !== undefined || value === null || value === undefined ? (
              <span className="tabular-nums">{display ?? "—"}</span>
            ) : (
              <NumberTicker value={value} format={format} currency={currency} />
            )}
          </p>
          <div className="mt-1.5 flex min-h-[20px] flex-wrap items-center gap-2">
            {delta !== null && delta !== undefined && Number.isFinite(delta) ? (
              <DeltaChip delta={delta} invert={invertDelta} label={deltaLabel} />
            ) : null}
            {hint ? <span className="text-xs text-muted-foreground">{hint}</span> : null}
          </div>
        </div>
        {aside ? <div className="shrink-0">{aside}</div> : null}
      </div>
    </motion.div>
  );
}

export function DeltaChip({ delta, invert = false, label }: { delta: number; invert?: boolean; label?: string }) {
  const flat = Math.abs(delta) < 0.005;
  const good = flat ? null : invert ? delta < 0 : delta > 0;
  const Icon = flat ? Minus : delta > 0 ? ArrowUpRight : ArrowDownRight;
  const text = `${delta > 0 ? "+" : ""}${Math.round(delta * 100)}%`;
  const chip = (
    <span
      className={cn(
        "inline-flex items-center gap-0.5 rounded-md px-1.5 py-0.5 text-2xs font-semibold tabular-nums",
        good === null && "bg-muted text-muted-foreground",
        good === true && "bg-brand-soft text-brand-text",
        good === false && "bg-danger-soft text-danger",
      )}
    >
      <Icon className="h-3 w-3" aria-hidden="true" />
      {text}
      {label ? <span className="sr-only"> {label}</span> : null}
    </span>
  );
  return label ? <Tooltip content={label}>{chip}</Tooltip> : chip;
}
