"use client";

/** "Download PDF": opens the browser's print dialog (Save as PDF). Print CSS hides everything but the receipt. */
export function PrintButton({ label = "Download PDF" }: { label?: string }) {
  return (
    <button
      type="button"
      onClick={() => window.print()}
      className="rounded-lg border border-neutral-300 bg-white px-3 py-2 text-sm font-medium text-neutral-700 hover:border-neutral-400 hover:text-ink print:hidden"
    >
      {label}
    </button>
  );
}
