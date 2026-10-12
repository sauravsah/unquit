import { ArrowRight, Plug } from "lucide-react";
import Link from "next/link";
import { cn } from "@/components/ui/cn";

/**
 * Kept for compatibility: the sidebar, top bar and navigation now live in
 * app/dashboard/layout.tsx (AppShell), so this only renders its children.
 * The props are accepted and ignored so existing pages keep compiling.
 */
export function DashboardShell({
  children,
}: {
  email?: string | undefined;
  active?: string;
  showTabs?: boolean;
  children: React.ReactNode;
}) {
  return <>{children}</>;
}

/** Title row used at the top of every dashboard page. */
export function PageHeader({
  title,
  description,
  actions,
  badge,
  className,
}: {
  title: string;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  badge?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("mb-8 flex flex-wrap items-end justify-between gap-4", className)}>
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2.5">
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">{title}</h1>
          {badge}
        </div>
        {description ? <p className="mt-1.5 max-w-2xl text-sm text-muted-foreground">{description}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}

/** Shown on sub-pages until Stripe is connected. */
export function ConnectFirst() {
  return (
    <section className="relative mx-auto max-w-xl overflow-hidden rounded-2xl border border-border bg-card p-10 text-center shadow-card">
      <div aria-hidden="true" className="bg-grid mask-radial absolute inset-0 opacity-70" />
      <div aria-hidden="true" className="absolute left-1/2 top-0 h-40 w-72 -translate-x-1/2 rounded-full bg-brand/20 blur-3xl" />
      <div className="relative">
        <span className="mx-auto flex h-12 w-12 items-center justify-center rounded-xl border border-border bg-background shadow-lift">
          <Plug className="h-5 w-5 text-brand-text" />
        </span>
        <h1 className="mt-5 text-2xl font-semibold tracking-tight text-foreground">Connect Stripe first</h1>
        <p className="mt-3 text-sm text-muted-foreground">
          The cancel flow and payment recovery work on your Stripe subscriptions, so connect your account first.
        </p>
        <Link
          href="/dashboard"
          className="mt-8 inline-flex h-10 items-center gap-2 rounded-lg bg-foreground px-5 text-sm font-medium text-background shadow-xs transition-transform hover:bg-foreground/85 active:scale-[0.97]"
        >
          Go to overview <ArrowRight className="h-4 w-4" />
        </Link>
      </div>
    </section>
  );
}
