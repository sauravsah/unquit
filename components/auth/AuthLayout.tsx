import { CheckCircle2 } from "lucide-react";
import { Wordmark } from "@/components/Wordmark";
import { ThemeToggle } from "@/components/theme/ThemeToggle";

/**
 * The split-screen frame shared by /login, /signup and /signout: the form on
 * the left, the brand panel (sample verified receipt) on the right.
 */
export function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid min-h-screen bg-background lg:grid-cols-2">
      {/* Form side */}
      <div className="relative flex flex-col px-6 py-8 sm:px-10">
        <div className="flex items-center justify-between">
          <Wordmark />
          <ThemeToggle />
        </div>
        <div className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center py-12 animate-slide-up">{children}</div>
      </div>

      {/* Brand side */}
      <div className="relative hidden overflow-hidden border-l border-border bg-zinc-950 text-white lg:flex lg:flex-col lg:justify-between lg:p-12">
        <div aria-hidden="true" className="absolute inset-0 opacity-60 [background-image:linear-gradient(to_right,rgb(255_255_255/0.06)_1px,transparent_1px),linear-gradient(to_bottom,rgb(255_255_255/0.06)_1px,transparent_1px)] [background-size:48px_48px] [mask-image:radial-gradient(ellipse_80%_70%_at_60%_40%,black_30%,transparent_80%)]" />
        <div aria-hidden="true" className="absolute -right-24 top-10 h-[420px] w-[420px] animate-aurora rounded-full bg-brand/30 blur-[110px]" />
        <div aria-hidden="true" className="absolute -bottom-32 left-10 h-[320px] w-[320px] animate-aurora rounded-full bg-emerald-400/10 blur-[100px] [animation-delay:-6s]" />

        <p className="relative text-sm font-medium text-zinc-400">Churn recovery for Stripe</p>

        <div className="relative">
          <div className="max-w-md rounded-2xl border border-white/10 bg-white/[0.04] p-5 shadow-2xl backdrop-blur-xl animate-float">
            <div className="flex items-center justify-between text-xs text-zinc-400">
              <span className="font-mono">UQ-0001042</span>
              <span className="inline-flex items-center gap-1 rounded-full border border-emerald-400/30 bg-emerald-400/10 px-2 py-0.5 font-semibold tracking-wide text-emerald-300">
                <CheckCircle2 className="h-3 w-3" /> VERIFIED IN STRIPE
              </span>
            </div>
            <p className="mt-4 text-sm text-zinc-400">Saved · 30% off for 3 months</p>
            <p className="mt-1 text-3xl font-semibold tracking-tight">
              $249<span className="text-base font-normal text-zinc-500">/mo kept</span>
            </p>
            <div className="mt-4 h-1.5 overflow-hidden rounded-full bg-white/10">
              <div className="h-full w-2/3 rounded-full bg-gradient-to-r from-brand to-emerald-300" />
            </div>
            <p className="mt-2 text-xs text-zinc-500">Fee: 20% for the first 3 paid months, then $0.</p>
          </div>
          <blockquote className="mt-10 max-w-md">
            <p className="text-2xl font-medium leading-snug tracking-tight">
              Unquit your customers. <span className="text-zinc-500">Pay only for the ones we keep.</span>
            </p>
          </blockquote>
        </div>

        <ul className="relative flex flex-wrap gap-x-6 gap-y-2 text-xs text-zinc-400">
          <li>$0 base fee</li>
          <li>Every save verified in Stripe</li>
          <li>Capped at $299 / month</li>
        </ul>
      </div>
    </div>
  );
}

/** The red alert box the auth pages use for errors. */
export function AuthAlert({ children }: { children: React.ReactNode }) {
  return (
    <p role="alert" className="mt-6 rounded-xl border border-danger/30 bg-danger-soft px-3.5 py-2.5 text-sm text-danger">
      {children}
    </p>
  );
}

/** The green notice box (signed out, account created). */
export function AuthNotice({ children }: { children: React.ReactNode }) {
  return (
    <p role="status" className="mt-6 rounded-xl border border-brand/30 bg-brand-soft px-3.5 py-2.5 text-sm text-foreground">
      {children}
    </p>
  );
}
