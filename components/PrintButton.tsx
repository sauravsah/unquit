"use client";

import { Download } from "lucide-react";
import { Button } from "@/components/ui/button";

/** "Download PDF": opens the browser's print dialog (Save as PDF). Print CSS hides everything but the receipt. */
export function PrintButton({ label = "Download PDF" }: { label?: string }) {
  return (
    <Button type="button" variant="secondary" size="sm" onClick={() => window.print()} className="print:hidden">
      <Download className="h-3.5 w-3.5" aria-hidden="true" />
      {label}
    </Button>
  );
}
