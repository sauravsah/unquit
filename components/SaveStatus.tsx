import { Badge, StatusPill } from "@/components/ui/badge";
import type { SaveStatus } from "@/lib/ledger/types";

export const SAVE_STATUS: Record<SaveStatus, { label: string; style: string }> = {
  pending: { label: "Pending", style: "border-border bg-muted text-muted-foreground" },
  verified: { label: "Verified", style: "border-brand/25 bg-brand-soft text-brand-text" },
  disputed: { label: "Disputed", style: "border-warning/25 bg-warning-soft text-warning" },
  clawed_back: { label: "Reversed", style: "border-danger/25 bg-danger-soft text-danger line-through" },
  lost: { label: "Lost", style: "border-border bg-muted text-muted-foreground" },
};

export function SaveStatusBadge({ status, ended = false }: { status: SaveStatus; ended?: boolean }) {
  const s = SAVE_STATUS[status];
  return (
    <span className="inline-flex flex-wrap items-center justify-end gap-1.5">
      <StatusPill status={status} label={s.label} />
      {ended && status !== "lost" ? <Badge tone="outline">cancelled later</Badge> : null}
    </span>
  );
}
