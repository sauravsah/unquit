"use client";

import { motion } from "framer-motion";
import { ArrowRight, Check } from "lucide-react";
import Link from "next/link";
import { cn } from "@/components/ui/cn";
import { ProgressBar } from "@/components/ui/progress-ring";

export type ChecklistStep = {
  id: string;
  title: string;
  description: string;
  done: boolean;
  href: string;
  cta: string;
  /** A plain <a> for routes that leave the app (Stripe Connect). */
  external?: boolean;
};

/** "Get set up" card with progress. Hidden by the page once every step is done. */
export function OnboardingChecklist({ steps, className }: { steps: ChecklistStep[]; className?: string }) {
  const done = steps.filter((s) => s.done).length;
  const next = steps.find((s) => !s.done);
  return (
    <section className={cn("overflow-hidden rounded-xl border border-border bg-card shadow-card", className)} aria-labelledby="setup-title">
      <div className="relative border-b border-border px-5 py-4">
        <div aria-hidden="true" className="pointer-events-none absolute -right-16 -top-20 h-40 w-64 rounded-full bg-brand/15 blur-3xl" />
        <div className="relative flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 id="setup-title" className="text-sm font-semibold text-foreground">
              Get set up
            </h2>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {done} of {steps.length} done. Most founders finish in under ten minutes.
            </p>
          </div>
          <div className="flex items-center gap-3">
            <Link
              href="/dashboard/install"
              className="inline-flex items-center gap-1 rounded text-xs font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              Full setup guide <ArrowRight className="h-3 w-3" aria-hidden="true" />
            </Link>
            <span className="text-xs font-medium tabular-nums text-brand-text">{Math.round((done / steps.length) * 100)}%</span>
          </div>
        </div>
        <ProgressBar value={done / steps.length} label="Setup progress" className="relative mt-3" />
      </div>
      <ol className="divide-y divide-border">
        {steps.map((step, i) => {
          const isNext = step === next;
          const Cta = step.external ? "a" : Link;
          return (
            <li key={step.id} className={cn("flex items-center gap-4 px-5 py-3.5 transition-colors", isNext && "bg-brand-soft/40")}>
              <motion.span
                initial={false}
                animate={step.done ? { scale: [0.8, 1.15, 1] } : { scale: 1 }}
                className={cn(
                  "flex h-6 w-6 shrink-0 items-center justify-center rounded-full border text-2xs font-semibold",
                  step.done ? "border-brand bg-brand text-white shadow-glow-sm" : isNext ? "border-brand/50 text-brand-text" : "border-border text-muted-foreground",
                )}
              >
                {step.done ? <Check className="h-3.5 w-3.5" aria-hidden="true" /> : i + 1}
              </motion.span>
              <div className="min-w-0 flex-1">
                <p className={cn("text-sm font-medium", step.done ? "text-muted-foreground line-through decoration-border" : "text-foreground")}>
                  {step.title}
                  <span className="sr-only">{step.done ? " (done)" : ""}</span>
                </p>
                <p className="mt-0.5 text-xs text-muted-foreground">{step.description}</p>
              </div>
              {!step.done ? (
                <Cta
                  href={step.href}
                  className={cn(
                    "inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg px-3 text-xs font-medium transition-[transform,background-color] active:scale-[0.97]",
                    isNext ? "bg-foreground text-background hover:bg-foreground/85" : "border border-border bg-card text-foreground hover:bg-muted",
                  )}
                >
                  {step.cta} <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
                </Cta>
              ) : null}
            </li>
          );
        })}
      </ol>
    </section>
  );
}
