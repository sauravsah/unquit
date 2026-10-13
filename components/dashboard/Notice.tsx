import { cn } from "@/components/ui/cn";

export type NoticeTone = "good" | "bad" | "neutral";

/** A one-line status banner (query-string results, setup outcomes). Matches the overview's banner. */
export function Notice({ tone, children, className }: { tone: NoticeTone; children: React.ReactNode; className?: string }) {
  const styles = {
    good: "border-brand/30 bg-brand-soft text-foreground",
    bad: "border-danger/30 bg-danger-soft text-danger",
    neutral: "border-border bg-card text-muted-foreground",
  }[tone];
  return (
    <p
      role={tone === "bad" ? "alert" : "status"}
      className={cn("flex items-start gap-2.5 rounded-xl border px-4 py-3 text-sm shadow-xs animate-slide-up", styles, className)}
    >
      <span
        aria-hidden="true"
        className={cn("mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full", tone === "good" ? "bg-brand" : tone === "bad" ? "bg-danger" : "bg-muted-foreground")}
      />
      <span>{children}</span>
    </p>
  );
}
