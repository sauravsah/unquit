"use client";

import { animate, useInView, useReducedMotion } from "framer-motion";
import { useEffect, useRef } from "react";
import { cn } from "./cn";

export type NumberFormat = "cents" | "dollars" | "percent" | "integer";

/** Formats the way the dashboard does everywhere. `percent` takes a 0..1 fraction. */
export function formatNumber(value: number, format: NumberFormat, currency = "usd", decimals?: number): string {
  switch (format) {
    case "cents":
    case "dollars": {
      const amount = format === "cents" ? value / 100 : value;
      const digits = decimals ?? (format === "cents" ? 2 : 0);
      return new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: currency.toUpperCase(),
        minimumFractionDigits: digits,
        maximumFractionDigits: digits,
      }).format(amount);
    }
    case "percent":
      return `${(value * 100).toFixed(decimals ?? 0)}%`;
    case "integer":
      return new Intl.NumberFormat("en-US", { maximumFractionDigits: decimals ?? 0 }).format(value);
  }
}

/**
 * Counts up to `value` the first time it scrolls into view, then glides
 * between values when it changes (live updates). Writes straight to the DOM,
 * so it never re-renders React per frame. Reduced motion: jumps to the value.
 */
export function NumberTicker({
  value,
  format = "integer",
  currency,
  decimals,
  duration = 1.1,
  className,
}: {
  value: number;
  format?: NumberFormat;
  currency?: string;
  decimals?: number;
  duration?: number;
  className?: string;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const from = useRef(0);
  const inView = useInView(ref, { once: true, margin: "0px 0px -10% 0px" });
  const reduce = useReducedMotion();

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (reduce || !inView) {
      if (reduce) el.textContent = formatNumber(value, format, currency, decimals);
      if (reduce) from.current = value;
      return;
    }
    const controls = animate(from.current, value, {
      duration: from.current === 0 ? duration : 0.6,
      ease: [0.16, 1, 0.3, 1],
      onUpdate: (latest) => {
        const rounded = format === "cents" || format === "integer" ? Math.round(latest) : latest;
        el.textContent = formatNumber(rounded, format, currency, decimals);
      },
    });
    from.current = value;
    return () => controls.stop();
  }, [value, format, currency, decimals, duration, inView, reduce]);

  // Server render and first paint show the final number (no layout shift, good for SEO / no-JS).
  return (
    <span ref={ref} className={cn("tabular-nums", className)}>
      {formatNumber(value, format, currency, decimals)}
    </span>
  );
}
