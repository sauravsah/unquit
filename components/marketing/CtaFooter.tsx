import { ArrowRight } from "lucide-react";
import Link from "next/link";
import { Logo } from "@/components/Logo";
import { Button } from "@/components/ui/button";

export function CtaBand() {
  return (
    <section className="container pb-24">
      <div className="relative isolate overflow-hidden rounded-3xl border border-zinc-800 bg-zinc-950 px-6 py-16 text-center text-white shadow-float sm:px-12">
        <div aria-hidden="true" className="absolute inset-0 -z-10 opacity-60 [background-image:linear-gradient(to_right,rgb(255_255_255/0.06)_1px,transparent_1px),linear-gradient(to_bottom,rgb(255_255_255/0.06)_1px,transparent_1px)] [background-size:40px_40px] [mask-image:radial-gradient(ellipse_70%_80%_at_50%_100%,black_30%,transparent_75%)]" />
        <div aria-hidden="true" className="absolute -bottom-40 left-[calc(50%-320px)] -z-10 h-80 w-[640px] animate-aurora rounded-full bg-brand/40 blur-[100px]" />
        <h2 className="mx-auto max-w-2xl text-4xl font-semibold tracking-tight sm:text-5xl">Stop paying for churn tools that don&apos;t save churn.</h2>
        <p className="mx-auto mt-4 max-w-xl text-lg text-zinc-400">Connect Stripe in a minute. Pay nothing until a customer stays.</p>
        <div className="mt-9 flex flex-wrap items-center justify-center gap-3">
          <Button asChild variant="inverse" size="xl" className="group">
            <Link href="/signup">
              Get started free <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
            </Link>
          </Button>
          <a href="#pricing" className="inline-flex h-12 items-center rounded-lg border border-white/15 px-6 text-base font-medium text-white transition-colors hover:bg-white/5">
            See pricing
          </a>
        </div>
      </div>
    </section>
  );
}

export function Footer() {
  return (
    <footer className="border-t border-border">
      <div className="container flex flex-col gap-8 py-12 sm:flex-row sm:items-start sm:justify-between">
        <div className="max-w-xs">
          <Logo />
          <p className="mt-3 text-sm text-muted-foreground">Churn recovery for subscription businesses on Stripe. Pay only for the customers we keep.</p>
        </div>
        <div className="grid grid-cols-2 gap-x-12 gap-y-6 text-sm sm:grid-cols-3">
          <nav aria-label="Product" className="flex flex-col gap-2">
            <Link href="/#features" className="text-muted-foreground hover:text-foreground">Features</Link>
            <Link href="/#how" className="text-muted-foreground hover:text-foreground">How it works</Link>
            <Link href="/#pricing" className="text-muted-foreground hover:text-foreground">Pricing</Link>
            <Link href="/#faq" className="text-muted-foreground hover:text-foreground">FAQ</Link>
          </nav>
          <nav aria-label="Account" className="flex flex-col gap-2">
            <Link href="/login" className="text-muted-foreground hover:text-foreground">Sign in</Link>
            <Link href="/signup" className="text-muted-foreground hover:text-foreground">Get started</Link>
          </nav>
          <nav aria-label="Legal" className="flex flex-col gap-2">
            <Link href="/terms" className="text-muted-foreground hover:text-foreground">Terms</Link>
            <Link href="/privacy" className="text-muted-foreground hover:text-foreground">Privacy</Link>
            <Link href="/data-use" className="text-muted-foreground hover:text-foreground">Data use</Link>
          </nav>
        </div>
      </div>
      <div className="container flex flex-wrap items-center justify-between gap-2 border-t border-border py-6 text-xs text-muted-foreground">
        <span>© {new Date().getFullYear()} unquit</span>
        <span className="flex items-center gap-1.5">
          <span className="h-1.5 w-1.5 rounded-full bg-brand shadow-glow-sm" /> Built on Stripe
        </span>
      </div>
    </footer>
  );
}
