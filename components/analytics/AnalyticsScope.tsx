"use client";

import { usePathname } from "next/navigation";
import { useEffect } from "react";
import { analyticsAllowed, GA_MEASUREMENT_ID } from "@/lib/analytics";

/** Keeps Google Analytics switched off outside the public pages as the visitor navigates client-side. */
export function AnalyticsScope() {
  const pathname = usePathname();
  useEffect(() => {
    (window as unknown as Record<string, boolean>)[`ga-disable-${GA_MEASUREMENT_ID}`] = !analyticsAllowed(pathname ?? "/");
  }, [pathname]);
  return null;
}
