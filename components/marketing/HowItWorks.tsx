"use client";

import { motion, useScroll, useSpring, useTransform } from "framer-motion";
import { BadgeCheck, Plug, Sparkles } from "lucide-react";
import { useRef } from "react";
import { Reveal } from "@/components/motion";

const STEPS = [
  {
    icon: Plug,
    title: "Connect Stripe",
    body: "One click with Stripe Connect. No code changes to your billing, and you can disconnect any time.",
    meta: "~1 minute",
  },
  {
    icon: Sparkles,
    title: "We catch the leaving",
    body: "A cancel flow with the right offer, a pause or a short exit survey. Smart emails and a card-update link for failed payments.",
    meta: "One script tag",
  },
  {
    icon: BadgeCheck,
    title: "You pay for proof",
    body: "A save counts only when the customer's next invoice is paid. Every save gets a receipt you can dispute.",
    meta: "Capped at $299/mo",
  },
];

/** Three steps with a line that fills as you scroll through them. */
export function HowItWorks() {
  const ref = useRef<HTMLOListElement>(null);
  const { scrollYProgress } = useScroll({ target: ref, offset: ["start 75%", "end 55%"] });
  const progress = useSpring(scrollYProgress, { stiffness: 120, damping: 24, restDelta: 0.001 });
  const height = useTransform(progress, [0, 1], ["0%", "100%"]);

  return (
    <section id="how" className="relative scroll-mt-24 border-y border-border bg-surface py-24">
      <div className="container grid gap-14 lg:grid-cols-[1fr_1.3fr]">
        <Reveal className="lg:sticky lg:top-28 lg:self-start">
          <p className="text-sm font-medium text-brand-text">How it works</p>
          <h2 className="mt-3 text-4xl font-semibold tracking-tight text-foreground sm:text-5xl">Live in an afternoon. Paid for by results.</h2>
          <p className="mt-4 max-w-md text-lg text-muted-foreground">
            No sales call, no annual contract. Connect, drop in the widget, and watch the ledger fill up.
          </p>
        </Reveal>

        <ol ref={ref} className="relative space-y-6 pl-12">
          <span aria-hidden="true" className="absolute bottom-6 left-[19px] top-6 w-0.5 rounded-full bg-border" />
          <motion.span
            aria-hidden="true"
            style={{ height }}
            className="absolute left-[19px] top-6 w-0.5 origin-top rounded-full bg-gradient-to-b from-brand to-brand-glow shadow-glow-sm"
          />
          {STEPS.map((step, i) => {
            const Icon = step.icon;
            return (
              <motion.li
                key={step.title}
                initial={{ opacity: 0, y: 16 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true, margin: "-80px" }}
                transition={{ duration: 0.6, delay: i * 0.08, ease: [0.16, 1, 0.3, 1] }}
                className="relative"
              >
                  <span className="absolute -left-12 top-5 flex h-10 w-10 items-center justify-center rounded-xl border border-border bg-background text-brand-text shadow-lift">
                    <Icon className="h-4 w-4" />
                  </span>
                  <div className="rounded-2xl border border-border bg-card p-6 shadow-card transition-shadow hover:shadow-lift">
                    <div className="flex items-center justify-between gap-3">
                      <p className="font-mono text-xs text-subtle">0{i + 1}</p>
                      <span className="rounded-full border border-border px-2 py-0.5 text-2xs text-muted-foreground">{step.meta}</span>
                    </div>
                    <h3 className="mt-2 text-xl font-semibold tracking-tight text-foreground">{step.title}</h3>
                    <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{step.body}</p>
                  </div>
              </motion.li>
            );
          })}
        </ol>
      </div>
    </section>
  );
}
