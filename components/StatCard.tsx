import { StatCard as UiStatCard } from "@/components/ui/stat-card";

/**
 * Pre-formatted KPI tile (kept for older call sites). New code can use
 * `@/components/ui/stat-card` directly for animated numbers and delta chips.
 */
export function StatCard({
  label,
  value,
  hint,
  emphasis = false,
}: {
  label: string;
  value: string;
  hint?: string;
  emphasis?: boolean;
}) {
  return <UiStatCard label={label} display={value} hint={hint} emphasis={emphasis} />;
}
