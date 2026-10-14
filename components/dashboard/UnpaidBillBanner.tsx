import Link from "next/link";

/** Shown on every dashboard page while one of unquit's own fee charges is unpaid. */
export function UnpaidBillBanner() {
  return (
    <p role="alert" className="mb-6 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl border border-danger/30 bg-danger-soft px-4 py-3 text-sm text-danger shadow-xs">
      <span aria-hidden="true" className="h-1.5 w-1.5 shrink-0 rounded-full bg-danger" />
      <span>We couldn&apos;t charge your card for unquit&apos;s fees.</span>
      <Link href="/dashboard/billing" className="font-medium underline underline-offset-4 hover:no-underline">
        Update your billing card →
      </Link>
    </p>
  );
}
