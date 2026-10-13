import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "./cn";

export const badgeVariants = cva(
  "inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border px-2 py-0.5 text-2xs font-medium leading-4",
  {
    variants: {
      tone: {
        neutral: "border-border bg-muted text-muted-foreground",
        success: "border-brand/25 bg-brand-soft text-brand-text",
        warning: "border-warning/25 bg-warning-soft text-warning",
        danger: "border-danger/25 bg-danger-soft text-danger",
        info: "border-sky-500/25 bg-sky-500/10 text-sky-700 dark:text-sky-300",
        outline: "border-border bg-transparent text-foreground",
      },
    },
    defaultVariants: { tone: "neutral" },
  },
);

export type BadgeProps = React.HTMLAttributes<HTMLSpanElement> &
  VariantProps<typeof badgeVariants> & {
    /** Leading status dot. `pulse` animates it (for live / in-progress states). */
    dot?: boolean | "pulse";
  };

export function Badge({ className, tone, dot, children, ...props }: BadgeProps) {
  return (
    <span className={cn(badgeVariants({ tone }), className)} {...props}>
      {dot ? (
        <span className="relative flex h-1.5 w-1.5" aria-hidden="true">
          {dot === "pulse" ? <span className="absolute inline-flex h-full w-full animate-pulse-ring rounded-full bg-current" /> : null}
          <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-current" />
        </span>
      ) : null}
      {children}
    </span>
  );
}

/** Status pill with the tone picked for you. Unknown statuses fall back to neutral. */
const STATUS_TONES: Record<string, NonNullable<BadgeProps["tone"]>> = {
  verified: "success",
  saved: "success",
  recovered: "success",
  paid: "success",
  active: "success",
  connected: "success",
  pending: "neutral",
  open: "warning",
  disputed: "warning",
  in_progress: "info",
  offer_shown: "info",
  started: "info",
  clawed_back: "danger",
  failed: "danger",
  lost: "danger",
  canceled: "neutral",
  cancelled: "neutral",
  closed: "neutral",
  abandoned: "neutral",
};

export function StatusPill({ status, label, className }: { status: string; label?: string; className?: string }) {
  const tone = STATUS_TONES[status] ?? "neutral";
  const live = status === "open" || status === "pending" || status === "started" || status === "offer_shown";
  return (
    <Badge tone={tone} dot={live ? "pulse" : true} className={className}>
      {label ?? status.replace(/_/g, " ")}
    </Badge>
  );
}
