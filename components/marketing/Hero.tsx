"use client";

import { animate, motion, useReducedMotion } from "framer-motion";
import { ArrowRight, Check, Sparkles } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";

const EASE = [0.16, 1, 0.3, 1] as const;

export function Hero() {
  return (
    <section className="relative isolate overflow-hidden">
      <HeroBackground />
      <div className="container grid items-center gap-14 pb-20 pt-14 sm:pt-20 lg:grid-cols-[1.15fr_1fr] lg:pb-28 lg:pt-24">
        <div>
          <a
            href="#pricing"
            className="hero-in group inline-flex items-center gap-2 rounded-full border border-border bg-card/70 py-1 pl-1 pr-3 text-xs font-medium text-muted-foreground shadow-xs backdrop-blur transition-colors hover:text-foreground"
          >
            <span className="inline-flex items-center gap-1 rounded-full bg-brand-soft px-2 py-0.5 text-brand-text">
              <Sparkles className="h-3 w-3" /> New
            </span>
            $0 base fee. Capped at $299 a month.
            <ArrowRight className="h-3 w-3 transition-transform group-hover:translate-x-0.5" />
          </a>

          <h1
            style={{ animationDelay: "60ms" }}
            className="hero-in mt-6 text-5xl font-semibold tracking-tight text-foreground sm:text-6xl lg:text-7xl"
          >
            <span className="text-gradient">Unquit your customers.</span>{" "}
            <span className="text-gradient-brand">Pay only for the ones we keep.</span>
          </h1>

          <p
            style={{ animationDelay: "120ms" }}
            className="hero-in mt-6 max-w-xl text-lg leading-relaxed text-muted-foreground"
          >
            Cancel-flow offers, pauses and failed-payment recovery for subscription businesses on Stripe. No base fee, no annual
            contract. If we don&apos;t save revenue, you don&apos;t pay.
          </p>

          <div
            style={{ animationDelay: "200ms" }}
            className="hero-in mt-9 flex flex-wrap items-center gap-3"
          >
            <Button asChild variant="brand" size="xl" className="group">
              <Link href="/signup">
                Get started free <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
              </Link>
            </Button>
            <Button asChild variant="secondary" size="xl">
              <a href="#pricing">Estimate your fee</a>
            </Button>
          </div>

          <ul
            style={{ animationDelay: "320ms" }}
            className="hero-in mt-8 flex flex-wrap gap-x-6 gap-y-2 text-sm text-muted-foreground"
          >
            {["Connect Stripe in one click", "Sign up in 30 seconds", "No card needed"].map((t) => (
              <li key={t} className="flex items-center gap-1.5">
                <Check className="h-4 w-4 text-brand-text" /> {t}
              </li>
            ))}
          </ul>
        </div>

        <ReceiptCard />
      </div>
    </section>
  );
}

function HeroBackground() {
  return (
    <div aria-hidden="true" className="absolute inset-0 -z-10">
      <div className="bg-grid absolute inset-0 animate-grid-pan [mask-image:radial-gradient(ellipse_80%_60%_at_50%_0%,black_40%,transparent_80%)]" />
      <div className="absolute -top-40 left-[calc(50%-410px)] h-[520px] w-[820px] animate-aurora rounded-full bg-[radial-gradient(closest-side,rgb(34_197_94/0.28),transparent)] blur-2xl" />
      <div className="absolute -right-40 top-40 h-[380px] w-[380px] animate-aurora rounded-full bg-[radial-gradient(closest-side,rgb(16_185_129/0.18),transparent)] blur-2xl [animation-delay:-7s]" />
      <div className="absolute inset-x-0 bottom-0 h-40 bg-gradient-to-b from-transparent to-background" />
    </div>
  );
}

/** "Live" MRR counter: counts up on load, then ticks up now and then (an illustrative account). */
function MrrTicker() {
  const ref = useRef<HTMLSpanElement>(null);
  const reduce = useReducedMotion();
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const fmt = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;
    let value = 4312;
    if (reduce) {
      el.textContent = fmt(value);
      return;
    }
    const first = animate(0, value, { duration: 1.6, ease: EASE, onUpdate: (v) => (el.textContent = fmt(v)) });
    const steps = [29, 49, 19, 99, 39];
    let i = 0;
    const timer = setInterval(() => {
      const from = value;
      value += steps[i++ % steps.length]!;
      animate(from, value, { duration: 0.8, ease: EASE, onUpdate: (v) => (el.textContent = fmt(v)) });
    }, 4200);
    return () => {
      first.stop();
      clearInterval(timer);
    };
  }, [reduce]);
  return (
    <span ref={ref} className="tabular-nums">
      $4,312
    </span>
  );
}

function ReceiptCard() {
  return (
    <div className="relative mx-auto w-full max-w-md lg:mx-0 lg:justify-self-end">
      {/* Floating chips behind the card */}
      <motion.div
        aria-hidden="true"
        initial={{ opacity: 0, x: -20 }}
        animate={{ opacity: 1, x: 0 }}
        transition={{ delay: 0.6, duration: 0.6, ease: EASE }}
        className="absolute -left-6 top-10 z-0 hidden rotate-[-6deg] rounded-xl border border-border bg-card/90 px-3 py-2 text-xs shadow-lift backdrop-blur sm:block"
      >
        <span className="text-muted-foreground">Offer accepted</span>
        <span className="ml-2 font-semibold text-foreground">30% off · 3 mo</span>
      </motion.div>
      <motion.div
        aria-hidden="true"
        initial={{ opacity: 0, x: 20 }}
        animate={{ opacity: 1, x: 0 }}
        transition={{ delay: 0.8, duration: 0.6, ease: EASE }}
        className="absolute -right-4 bottom-16 z-20 hidden rotate-[5deg] rounded-xl border border-border bg-card/90 px-3 py-2 text-xs shadow-lift backdrop-blur sm:block"
      >
        <span className="text-muted-foreground">Card updated</span>
        <span className="ml-2 font-semibold text-brand-text">+$99 recovered</span>
      </motion.div>

      <motion.div
        initial={{ opacity: 0, y: 30, rotate: -2 }}
        animate={{ opacity: 1, y: 0, rotate: 0 }}
        transition={{ duration: 0.9, delay: 0.25, ease: EASE }}
        className="relative z-10"
      >
        <div className="animate-float">
          <div className="ring-gradient relative overflow-hidden rounded-3xl border border-border bg-card/90 p-6 shadow-float backdrop-blur-xl">
            <div aria-hidden="true" className="absolute -right-16 -top-16 h-48 w-48 rounded-full bg-brand/20 blur-3xl" />
            <div className="relative flex items-start justify-between">
              <div>
                <p className="text-2xs font-medium uppercase tracking-wider text-muted-foreground">Save receipt</p>
                <p className="mt-1 font-mono text-sm text-foreground">UQ-0001042</p>
              </div>
              <motion.span
                initial={{ opacity: 0, scale: 1.8, rotate: -18 }}
                animate={{ opacity: 1, scale: 1, rotate: -8 }}
                transition={{ delay: 1.1, type: "spring", stiffness: 300, damping: 14 }}
                className="inline-flex items-center gap-1 rounded-lg border-2 border-brand px-2 py-1 text-2xs font-bold tracking-widest text-brand-text shadow-glow-sm"
              >
                <Check className="h-3 w-3" strokeWidth={3} /> VERIFIED IN STRIPE
              </motion.span>
            </div>

            <dl className="relative mt-6 space-y-3 text-sm">
              {[
                ["Customer", "cus_Q8h…2fK"],
                ["Reason", "Too expensive"],
                ["Offer", "30% off for 3 months"],
                ["Proof", "Invoice in_1Q…9a paid"],
              ].map(([k, v]) => (
                <div key={k} className="flex items-center justify-between gap-4">
                  <dt className="text-muted-foreground">{k}</dt>
                  <dd className="truncate font-medium text-foreground">{v}</dd>
                </div>
              ))}
            </dl>

            <div className="relative mt-6 rounded-2xl border border-border bg-surface p-4">
              <div className="flex items-baseline justify-between">
                <span className="text-xs text-muted-foreground">Saved MRR</span>
                <span className="text-2xl font-semibold tracking-tight text-foreground">
                  $249<span className="text-sm font-normal text-muted-foreground">/mo</span>
                </span>
              </div>
              <div className="mt-3 flex items-center justify-between text-xs">
                <span className="text-muted-foreground">Your fee (month 1 of 3)</span>
                <span className="font-medium tabular-nums text-foreground">$49.80</span>
              </div>
            </div>

            <div className="relative mt-4 flex items-center justify-between rounded-2xl bg-foreground px-4 py-3 text-background">
              <span className="flex items-center gap-2 text-xs">
                <span className="relative flex h-2 w-2">
                  <span className="absolute inline-flex h-full w-full animate-pulse-ring rounded-full bg-brand-glow" />
                  <span className="relative inline-flex h-2 w-2 rounded-full bg-brand-glow" />
                </span>
                Live
              </span>
              <span className="text-sm">
                <span className="font-semibold">
                  <MrrTicker />
                </span>{" "}
                <span className="opacity-70">MRR unquit this month</span>
              </span>
            </div>
          </div>
        </div>
        <p className="mt-3 text-center text-2xs text-subtle">Example account. Your numbers will vary.</p>
      </motion.div>
    </div>
  );
}
