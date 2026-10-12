"use client";

import { AnimatePresence, motion, useInView, useReducedMotion } from "framer-motion";
import { Check, CreditCard, Gauge, Mail, ShieldCheck, Zap } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Reveal } from "@/components/motion";
import { cn } from "@/components/ui/cn";

/** Cycles 0..n-1 every `ms` while on screen (paused for reduced motion). */
function useCycle(n: number, ms: number) {
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref, { margin: "-20%" });
  const reduce = useReducedMotion();
  const [i, setI] = useState(0);
  useEffect(() => {
    if (!inView || reduce) return;
    const t = setInterval(() => setI((x) => (x + 1) % n), ms);
    return () => clearInterval(t);
  }, [inView, reduce, n, ms]);
  return [ref, i] as const;
}

export function Bento() {
  return (
    <section id="features" className="container scroll-mt-24 py-24">
      <Reveal className="mx-auto max-w-2xl text-center">
        <p className="text-sm font-medium text-brand-text">What unquit does</p>
        <h2 className="mt-3 text-4xl font-semibold tracking-tight text-foreground sm:text-5xl">Three ways revenue walks out. We close all three.</h2>
        <p className="mt-4 text-lg text-muted-foreground">One script tag and a Stripe connection. Every save is proven before you pay for it.</p>
      </Reveal>

      <div className="mt-14 grid gap-4 md:grid-cols-6">
        <Tile className="md:col-span-3 md:row-span-2" eyebrow="Cancel flow" title="Catch the cancel" body="An exit survey and the right offer for the reason: a discount, a pause or a downgrade. Applied in Stripe the moment they accept.">
          <CancelModalDemo />
        </Tile>
        <Tile className="md:col-span-3" eyebrow="Dunning" title="Chase the failed card" body="Three emails matched to why the card failed, and a card-update page that pays the invoice on the spot.">
          <CardRetryDemo />
        </Tile>
        <Tile className="md:col-span-3" eyebrow="Ledger" title="Prove every save" body="A save counts only when the next invoice is paid. Each gets a receipt you can dispute.">
          <ReceiptStackDemo />
        </Tile>
        <SmallTile className="md:col-span-2" icon={<Gauge className="h-4 w-4" />} title="$299 cap" body="However much we save, a month never costs more." />
        <SmallTile className="md:col-span-2" icon={<Zap className="h-4 w-4" />} title="~6 KB widget" body="Gzipped, framework-free, shadow DOM, accessible. Drops into any app." />
        <SmallTile className="md:col-span-2" icon={<ShieldCheck className="h-4 w-4" />} title="Abuse guard" body="One accepted offer per subscription every 90 days." />
      </div>
    </section>
  );
}

function Tile({
  className,
  eyebrow,
  title,
  body,
  children,
}: {
  className?: string;
  eyebrow: string;
  title: string;
  body: string;
  children: React.ReactNode;
}) {
  return (
    <Reveal className={cn("h-full", className)}>
      <motion.article
        whileHover={{ y: -4 }}
        transition={{ type: "spring", stiffness: 300, damping: 26 }}
        className="group relative flex h-full flex-col overflow-hidden rounded-3xl border border-border bg-card p-6 shadow-card transition-shadow duration-300 hover:shadow-lift"
      >
        <div aria-hidden="true" className="pointer-events-none absolute -right-20 -top-20 h-56 w-56 rounded-full bg-brand/0 blur-3xl transition-colors duration-500 group-hover:bg-brand/15" />
        <p className="text-2xs font-semibold uppercase tracking-widest text-brand-text">{eyebrow}</p>
        <h3 className="mt-2 text-xl font-semibold tracking-tight text-foreground">{title}</h3>
        <p className="mt-2 max-w-md text-sm leading-relaxed text-muted-foreground">{body}</p>
        <div className="relative mt-6 flex flex-1 items-end">{children}</div>
      </motion.article>
    </Reveal>
  );
}

function SmallTile({ className, icon, title, body }: { className?: string; icon: React.ReactNode; title: string; body: string }) {
  return (
    <Reveal className={cn("h-full", className)}>
      <motion.div
        whileHover={{ y: -3 }}
        className="flex h-full items-start gap-3 rounded-2xl border border-border bg-card p-5 shadow-card transition-shadow hover:shadow-lift"
      >
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-brand/25 bg-brand-soft text-brand-text">{icon}</span>
        <div>
          <p className="text-sm font-semibold text-foreground">{title}</p>
          <p className="mt-0.5 text-sm text-muted-foreground">{body}</p>
        </div>
      </motion.div>
    </Reveal>
  );
}

/* ----------------------------------------------------------- micro demos */

const OFFERS = [
  { reason: "Too expensive", headline: "30% off for the next 3 months", cta: "Keep my plan at 30% off" },
  { reason: "Not using it enough", headline: "Pause billing for a month", cta: "Pause instead" },
  { reason: "Need fewer features", headline: "Switch to Starter at $19/mo", cta: "Downgrade instead" },
];

function CancelModalDemo() {
  const [ref, i] = useCycle(OFFERS.length, 2800);
  const offer = OFFERS[i]!;
  return (
    <div ref={ref} aria-hidden="true" className="relative h-[300px] w-full overflow-hidden rounded-2xl border border-border bg-surface p-4">
      <div className="bg-grid absolute inset-0 opacity-60" />
      <div className="relative mx-auto mt-2 max-w-[300px] rounded-2xl border border-border bg-background p-4 shadow-float">
        <p className="text-xs text-muted-foreground">Why are you leaving?</p>
        <ul className="mt-2 space-y-1.5">
          {OFFERS.map((o, j) => (
            <li
              key={o.reason}
              className={cn(
                "flex items-center gap-2 rounded-lg border px-2.5 py-1.5 text-xs transition-colors duration-300",
                j === i ? "border-brand bg-brand-soft text-foreground" : "border-border text-muted-foreground",
              )}
            >
              <span className={cn("flex h-3 w-3 items-center justify-center rounded-full border", j === i ? "border-brand bg-brand" : "border-input")}>
                {j === i ? <span className="h-1 w-1 rounded-full bg-white" /> : null}
              </span>
              {o.reason}
            </li>
          ))}
        </ul>
        <div className="relative mt-3 h-[84px]">
          <AnimatePresence mode="popLayout">
            <motion.div
              key={i}
              initial={{ opacity: 0, y: 14, scale: 0.97 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: -10, scale: 0.97 }}
              transition={{ type: "spring", stiffness: 320, damping: 26 }}
              className="absolute inset-0 rounded-xl bg-foreground p-3 text-background"
            >
              <span className="inline-block rounded-full bg-brand px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider text-white">A special offer</span>
              <p className="mt-1 text-xs font-semibold">{offer.headline}</p>
              <span className="mt-2 block rounded-md bg-brand py-1 text-center text-[10px] font-semibold text-white">{offer.cta}</span>
            </motion.div>
          </AnimatePresence>
        </div>
      </div>
    </div>
  );
}

const CARD_STEPS = [
  { label: "Payment failed", detail: "expired_card", tone: "danger" as const, icon: CreditCard },
  { label: "Email sent", detail: "Day 0 · “Update your card”", tone: "neutral" as const, icon: Mail },
  { label: "Card updated", detail: "•••• 4242 · 3-D Secure passed", tone: "neutral" as const, icon: CreditCard },
  { label: "Invoice paid", detail: "+$99.00 recovered", tone: "success" as const, icon: Check },
];

function CardRetryDemo() {
  const [ref, i] = useCycle(CARD_STEPS.length, 1700);
  return (
    <div ref={ref} aria-hidden="true" className="flex h-[132px] w-full items-center gap-4 rounded-2xl border border-border bg-surface p-4">
      <motion.div
        animate={i === 0 ? { x: [0, -6, 6, -4, 4, 0] } : { x: 0 }}
        transition={{ duration: 0.45 }}
        className={cn(
          "relative flex h-[84px] w-[132px] shrink-0 flex-col justify-between rounded-xl p-3 text-white shadow-lift transition-[background] duration-500",
          i === 0 ? "bg-gradient-to-br from-zinc-700 to-zinc-900" : i === 3 ? "bg-gradient-to-br from-brand to-emerald-800" : "bg-gradient-to-br from-zinc-800 to-zinc-950",
        )}
      >
        <span className="h-3 w-5 rounded-sm bg-amber-300/80" />
        <span className="font-mono text-[11px] tracking-wider">•••• {i >= 2 ? "4242" : "0019"}</span>
        <AnimatePresence>
          {i === 0 ? (
            <motion.span initial={{ opacity: 0, scale: 0.6 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0 }} className="absolute right-2 top-2 rounded bg-red-500 px-1 text-[9px] font-bold">
              DECLINED
            </motion.span>
          ) : i === 3 ? (
            <motion.span initial={{ opacity: 0, scale: 0.6 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0 }} className="absolute right-2 top-2 flex h-4 w-4 items-center justify-center rounded-full bg-white text-brand">
              <Check className="h-3 w-3" strokeWidth={3} />
            </motion.span>
          ) : null}
        </AnimatePresence>
      </motion.div>
      <ol className="min-w-0 flex-1 space-y-1.5">
        {CARD_STEPS.map((s, j) => (
          <li key={s.label} className={cn("flex items-center gap-2 text-xs transition-opacity duration-300", j <= i ? "opacity-100" : "opacity-35")}>
            <span
              className={cn(
                "flex h-4 w-4 shrink-0 items-center justify-center rounded-full border transition-colors duration-300",
                j < i || (j === i && s.tone === "success") ? "border-brand bg-brand text-white" : j === i && s.tone === "danger" ? "border-red-500 bg-red-500 text-white" : j === i ? "border-foreground" : "border-input",
              )}
            >
              {j < i || (j === i && s.tone === "success") ? <Check className="h-2.5 w-2.5" strokeWidth={3} /> : null}
            </span>
            <span className="font-medium text-foreground">{s.label}</span>
            <span className="truncate text-muted-foreground">{s.detail}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}

const RECEIPTS = [
  { no: "UQ-0001039", what: "Pause · 1 month", amount: "$79/mo" },
  { no: "UQ-0001040", what: "Recovered invoice", amount: "$99.00" },
  { no: "UQ-0001041", what: "Downgrade to Starter", amount: "$19/mo" },
  { no: "UQ-0001042", what: "30% off · 3 months", amount: "$249/mo" },
];

function ReceiptStackDemo() {
  const [ref, i] = useCycle(RECEIPTS.length, 2200);
  // Show the 3 most recent, newest on top.
  const visible = [0, 1, 2].map((k) => RECEIPTS[(i - k + RECEIPTS.length * 2) % RECEIPTS.length]!);
  return (
    <div ref={ref} aria-hidden="true" className="relative h-[132px] w-full overflow-hidden rounded-2xl border border-border bg-surface px-4 pt-4">
      <div className="relative mx-auto h-full max-w-[340px]">
        <AnimatePresence initial={false}>
          {visible.map((r, k) => (
            <motion.div
              key={r.no}
              layout
              initial={{ opacity: 0, y: -40, scale: 1.04 }}
              animate={{ opacity: 1 - k * 0.25, y: k * 14, scale: 1 - k * 0.05, zIndex: 10 - k }}
              exit={{ opacity: 0, y: 50, scale: 0.85 }}
              transition={{ type: "spring", stiffness: 260, damping: 24 }}
              className="absolute inset-x-0 top-0 flex items-center justify-between rounded-xl border border-border bg-background px-3 py-2.5 shadow-lift"
            >
              <div className="min-w-0">
                <p className="font-mono text-[11px] text-muted-foreground">{r.no}</p>
                <p className="truncate text-xs font-medium text-foreground">{r.what}</p>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-xs font-semibold tabular-nums text-foreground">{r.amount}</span>
                <span className="rounded border border-brand/50 px-1 py-0.5 text-[8px] font-bold tracking-widest text-brand-text">VERIFIED</span>
              </div>
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
    </div>
  );
}
