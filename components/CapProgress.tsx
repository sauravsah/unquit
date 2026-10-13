import { formatCents, MONTHLY_FEE_CAP_CENTS } from "@/lib/pricing";

/** A thin progress bar toward the $299 monthly cap. */
export function CapProgress({ cents, capCents = MONTHLY_FEE_CAP_CENTS, label }: { cents: number; capCents?: number; label?: string }) {
  const pct = capCents > 0 ? Math.min(100, Math.round((cents / capCents) * 100)) : 0;
  return (
    <div>
      <div
        className="h-2 w-full overflow-hidden rounded-full bg-muted"
        role="progressbar"
        aria-label={label ?? "Fees toward the monthly cap"}
        aria-valuemin={0}
        aria-valuemax={capCents}
        aria-valuenow={Math.min(cents, capCents)}
        aria-valuetext={`${formatCents(Math.min(cents, capCents))} of ${formatCents(capCents)}`}
      >
        <div className="h-full rounded-full bg-gradient-to-r from-brand to-brand-glow shadow-glow-sm transition-all duration-700 ease-spring" style={{ width: `${pct}%` }} />
      </div>
      <p className="mt-1.5 flex flex-wrap justify-between gap-x-3 text-xs text-muted-foreground">
        <span>
          <span className="tabular-nums text-foreground">{formatCents(Math.min(cents, capCents))}</span> of {formatCents(capCents)} cap
          {cents >= capCents ? " — cap reached, nothing more this month" : ""}
        </span>
        <span className="tabular-nums">{pct}%</span>
      </p>
    </div>
  );
}
