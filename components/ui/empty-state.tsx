import { cn } from "./cn";

type Art = "receipts" | "chart" | "inbox" | "card" | "flow" | "pulse";

/** Friendly "nothing here yet" panel with a small CSS/SVG illustration. */
export function EmptyState({
  title,
  description,
  action,
  art = "inbox",
  className,
  compact,
}: {
  title: string;
  description?: React.ReactNode;
  action?: React.ReactNode;
  art?: Art;
  className?: string;
  compact?: boolean;
}) {
  return (
    <div className={cn("flex flex-col items-center justify-center text-center", compact ? "px-4 py-8" : "px-6 py-14", className)}>
      <Illustration art={art} />
      <h3 className="mt-5 text-sm font-semibold text-foreground">{title}</h3>
      {description ? <p className="mt-1.5 max-w-sm text-sm text-muted-foreground">{description}</p> : null}
      {action ? <div className="mt-5">{action}</div> : null}
    </div>
  );
}

function Illustration({ art }: { art: Art }) {
  return (
    <div aria-hidden="true" className="relative h-24 w-32">
      <div className="absolute inset-0 rounded-full bg-brand/10 blur-2xl" />
      <svg viewBox="0 0 128 96" className="relative h-full w-full" fill="none">
        {art === "receipts" ? (
          <>
            <rect x="34" y="22" width="56" height="64" rx="8" className="fill-card stroke-border" strokeWidth="1.5" transform="rotate(-8 62 54)" />
            <rect x="38" y="14" width="56" height="66" rx="8" className="fill-card stroke-border" strokeWidth="1.5" />
            <rect x="47" y="26" width="26" height="4" rx="2" className="fill-muted-foreground/30" />
            <rect x="47" y="36" width="38" height="3" rx="1.5" className="fill-muted" />
            <rect x="47" y="44" width="32" height="3" rx="1.5" className="fill-muted" />
            <circle cx="80" cy="64" r="9" className="fill-brand/15 stroke-brand" strokeWidth="1.5" />
            <path d="M76 64l3 3 5-6" className="stroke-brand" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
          </>
        ) : art === "chart" ? (
          <>
            <rect x="14" y="14" width="100" height="68" rx="10" className="fill-card stroke-border" strokeWidth="1.5" />
            <path d="M24 66 L44 52 L60 58 L80 36 L104 30" className="stroke-brand" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" strokeDasharray="4 5" />
            <path d="M24 66 L44 52 L60 58 L80 36 L104 30 L104 74 L24 74Z" className="fill-brand/10" />
            <circle cx="104" cy="30" r="3.5" className="fill-brand" />
          </>
        ) : art === "card" ? (
          <>
            <rect x="22" y="22" width="84" height="54" rx="9" className="fill-card stroke-border" strokeWidth="1.5" />
            <rect x="22" y="34" width="84" height="9" className="fill-muted" />
            <rect x="32" y="54" width="22" height="5" rx="2.5" className="fill-muted-foreground/30" />
            <circle cx="92" cy="62" r="11" className="fill-brand/15 stroke-brand" strokeWidth="1.5" />
            <path d="M87 62h10M92 57v10" className="stroke-brand" strokeWidth="1.8" strokeLinecap="round" />
          </>
        ) : art === "flow" ? (
          <>
            <rect x="16" y="30" width="30" height="36" rx="7" className="fill-card stroke-border" strokeWidth="1.5" />
            <rect x="82" y="18" width="30" height="26" rx="7" className="fill-brand/15 stroke-brand" strokeWidth="1.5" />
            <rect x="82" y="54" width="30" height="26" rx="7" className="fill-card stroke-border" strokeWidth="1.5" />
            <path d="M46 44 C64 44 64 31 82 31 M46 52 C64 52 64 67 82 67" className="stroke-muted-foreground/50" strokeWidth="1.5" />
          </>
        ) : art === "pulse" ? (
          <>
            <circle cx="64" cy="48" r="30" className="stroke-border" strokeWidth="1.5" />
            <circle cx="64" cy="48" r="18" className="stroke-brand/40" strokeWidth="1.5" />
            <circle cx="64" cy="48" r="6" className="fill-brand" />
            <path d="M10 48h26l6-12 8 24 6-12h52" className="stroke-brand" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
          </>
        ) : (
          <>
            <path d="M20 50 L36 22 H92 L108 50 V72 A8 8 0 0 1 100 80 H28 A8 8 0 0 1 20 72Z" className="fill-card stroke-border" strokeWidth="1.5" />
            <path d="M20 50 H46 L52 60 H76 L82 50 H108" className="stroke-border" strokeWidth="1.5" />
            <circle cx="64" cy="38" r="5" className="fill-brand" />
          </>
        )}
      </svg>
    </div>
  );
}
