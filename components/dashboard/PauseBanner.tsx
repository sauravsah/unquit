import Link from "next/link";
import type { PauseBanner as PauseBannerState } from "@/lib/billing/pause";

const dateLabel = (iso: string) => new Date(iso).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });

/**
 * Shown on every dashboard page while Unquit is paused for an unpaid bill, or
 * during the 3-day warning before it pauses (lib/billing/pause.ts).
 */
export function PauseBanner({ banner }: { banner: NonNullable<PauseBannerState> }) {
  const paused = banner.state === "paused";
  return (
    <div
      role="alert"
      className="mb-6 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border border-danger/30 bg-danger-soft px-4 py-3 text-sm text-danger shadow-xs"
    >
      <span aria-hidden="true" className="h-1.5 w-1.5 shrink-0 rounded-full bg-danger" />
      <span className="min-w-0 flex-1">
        {paused ? (
          <>
            <strong className="font-semibold">Unquit is paused.</strong>{" "}
            {banner.byAdmin
              ? "Your account was paused by the Unquit team. "
              : "Your Unquit bill is unpaid. "}
            Your cancel flow shows no offers and no failed-payment emails are going out. Your customers can still cancel as normal.
          </>
        ) : (
          <>
            <strong className="font-semibold">Unquit will pause on {dateLabel(banner.pauseOn)}</strong> unless your card is updated. Your
            last bill couldn&apos;t be charged.
          </>
        )}
      </span>
      {paused && banner.byAdmin ? null : (
        <Link
          href="/dashboard/billing"
          className="shrink-0 rounded-md bg-danger px-3 py-1.5 text-xs font-semibold text-danger-soft shadow-xs hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          Update card and resume
        </Link>
      )}
    </div>
  );
}
