/**
 * A clean "paper receipt": white sheet, hairline border, a torn (zig-zag)
 * bottom edge. Used by save receipts and monthly statements.
 */
export function Paper({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={`relative mx-auto max-w-2xl print:max-w-none ${className}`}>
      <article className="rounded-t-xl border border-b-0 border-neutral-200 bg-white px-6 py-8 shadow-sm sm:px-10 print:rounded-none print:border-0 print:px-0 print:shadow-none">
        {children}
      </article>
      <div
        aria-hidden
        className="h-3 w-full print:hidden"
        style={{
          background:
            "linear-gradient(-45deg, transparent 6px, #ffffff 6px) 0 0 / 12px 12px repeat-x, linear-gradient(45deg, transparent 6px, #ffffff 6px) 0 0 / 12px 12px repeat-x",
          filter: "drop-shadow(0 1px 0 #e5e5e5)",
        }}
      />
    </div>
  );
}

/** A dashed rule, like the tear lines on a till receipt. */
export function Rule() {
  return <hr className="my-6 border-0 border-t border-dashed border-neutral-300" />;
}

/** Label ......... value rows. */
export function Row({ label, children, strong = false }: { label: string; children: React.ReactNode; strong?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-1.5 text-sm">
      <dt className="text-neutral-500">{label}</dt>
      <dd className={`text-right tabular-nums ${strong ? "font-semibold text-ink" : "text-neutral-800"}`}>{children}</dd>
    </div>
  );
}
