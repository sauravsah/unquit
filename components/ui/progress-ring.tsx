"use client";

import { motion, useReducedMotion } from "framer-motion";
import { cn } from "./cn";

/** Radial progress (0..1). Turns amber near the limit and green-glows when full. */
export function ProgressRing({
  value,
  size = 56,
  stroke = 6,
  label,
  className,
  children,
}: {
  value: number;
  size?: number;
  stroke?: number;
  label: string;
  className?: string;
  children?: React.ReactNode;
}) {
  const reduce = useReducedMotion();
  const clamped = Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const color = clamped >= 1 ? "stroke-brand" : clamped >= 0.8 ? "stroke-amber-500" : "stroke-brand";
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(clamped * 100)}
      className={cn("relative inline-flex items-center justify-center", className)}
      style={{ width: size, height: size }}
    >
      <svg width={size} height={size} className={cn("-rotate-90", clamped >= 1 && "drop-shadow-[0_0_8px_rgba(34,197,94,.55)]")}>
        <circle cx={size / 2} cy={size / 2} r={r} strokeWidth={stroke} className="fill-none stroke-muted" />
        <motion.circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          strokeWidth={stroke}
          strokeLinecap="round"
          className={cn("fill-none", color)}
          strokeDasharray={c}
          initial={{ strokeDashoffset: reduce ? c * (1 - clamped) : c }}
          animate={{ strokeDashoffset: c * (1 - clamped) }}
          transition={{ duration: reduce ? 0 : 1.1, ease: [0.16, 1, 0.3, 1] }}
        />
      </svg>
      <span className="absolute inset-0 flex items-center justify-center text-2xs font-semibold tabular-nums text-foreground">
        {children ?? `${Math.round(clamped * 100)}%`}
      </span>
    </div>
  );
}

/** Linear progress bar with a spring fill. */
export function ProgressBar({ value, label, className }: { value: number; label: string; className?: string }) {
  const clamped = Math.max(0, Math.min(1, value));
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(clamped * 100)}
      className={cn("h-1.5 w-full overflow-hidden rounded-full bg-muted", className)}
    >
      <motion.div
        className="h-full rounded-full bg-gradient-to-r from-brand to-brand-glow shadow-glow-sm"
        initial={{ width: 0 }}
        animate={{ width: `${clamped * 100}%` }}
        transition={{ type: "spring", stiffness: 120, damping: 22 }}
      />
    </div>
  );
}
