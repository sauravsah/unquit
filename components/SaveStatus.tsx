import type { SaveStatus } from "@/lib/ledger/types";

export const SAVE_STATUS: Record<SaveStatus, { label: string; style: string }> = {
  pending: { label: "Pending", style: "bg-neutral-100 text-neutral-700" },
  verified: { label: "Verified", style: "bg-brand-light text-brand-dark" },
  disputed: { label: "Disputed", style: "bg-amber-100 text-amber-800" },
  clawed_back: { label: "Reversed", style: "bg-neutral-100 text-neutral-500 line-through" },
  lost: { label: "Lost", style: "bg-neutral-100 text-neutral-500" },
};

export function SaveStatusBadge({ status, ended = false }: { status: SaveStatus; ended?: boolean }) {
  const s = SAVE_STATUS[status];
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${s.style}`}>{s.label}</span>
      {ended && status !== "lost" ? <span className="text-xs text-neutral-500">· cancelled later</span> : null}
    </span>
  );
}
