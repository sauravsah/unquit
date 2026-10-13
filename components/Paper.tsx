import { cn } from "@/components/ui/cn";

/**
 * A clean "paper receipt": card surface, hairline border, a torn (zig-zag)
 * bottom edge. Used by save receipts and monthly statements. Follows the
 * theme tokens on screen and prints on plain white paper.
 */
export function Paper({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={cn("relative mx-auto max-w-2xl animate-slide-up print:max-w-none print:animate-none", className)}>
      <article className="relative overflow-hidden rounded-t-2xl border border-b-0 border-border bg-card px-5 py-7 text-card-foreground shadow-lift sm:px-10 sm:py-9 print:overflow-visible print:rounded-none print:border-0 print:px-0 print:shadow-none">
        <div aria-hidden="true" className="absolute inset-x-0 top-0 h-1 bg-gradient-to-r from-brand-dark via-brand to-brand-glow print:hidden" />
        {children}
      </article>
      <div
        aria-hidden="true"
        className="h-3 w-full print:hidden"
        style={{
          background:
            "linear-gradient(-45deg, transparent 6px, rgb(var(--card)) 6px) 0 0 / 12px 12px repeat-x, linear-gradient(45deg, transparent 6px, rgb(var(--card)) 6px) 0 0 / 12px 12px repeat-x",
          filter: "drop-shadow(0 1px 0 rgb(var(--border)))",
        }}
      />
    </div>
  );
}

/** A dashed rule, like the tear lines on a till receipt. */
export function Rule() {
  return <hr className="my-6 border-0 border-t border-dashed border-border" />;
}

/** Small uppercase section heading inside a receipt or statement. */
export function SectionLabel({ children, className, id }: { children: React.ReactNode; className?: string; id?: string }) {
  return (
    <h2 id={id} className={cn("text-2xs font-semibold uppercase tracking-[0.14em] text-muted-foreground", className)}>
      {children}
    </h2>
  );
}

/** Label ......... value rows. */
export function Row({ label, children, strong = false }: { label: string; children: React.ReactNode; strong?: boolean }) {
  return (
    <div className="flex flex-col gap-0.5 py-2 text-sm sm:flex-row sm:items-baseline sm:justify-between sm:gap-6">
      <dt className="shrink-0 text-muted-foreground">{label}</dt>
      <dd className={cn("min-w-0 break-words tabular-nums sm:text-right", strong ? "text-base font-semibold text-foreground" : "text-foreground")}>{children}</dd>
    </div>
  );
}
