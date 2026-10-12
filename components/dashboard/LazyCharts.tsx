"use client";

import dynamic from "next/dynamic";
import { Skeleton } from "@/components/ui/skeleton";

/** Recharts is split into its own chunk and only loads in the browser; the skeleton holds the exact space (no layout shift). */
export const LazySavedMrrChart = dynamic(() => import("./Charts").then((m) => m.SavedMrrChart), {
  ssr: false,
  loading: () => <Skeleton className="h-[260px] w-full rounded-lg" />,
});

export const LazyReasonsDonut = dynamic(() => import("./Charts").then((m) => m.ReasonsDonut), {
  ssr: false,
  loading: () => (
    <div className="flex items-center gap-5">
      <Skeleton className="h-[168px] w-[168px] shrink-0 rounded-full" />
      <div className="w-full space-y-2">
        <Skeleton className="h-3 w-full" />
        <Skeleton className="h-3 w-4/5" />
        <Skeleton className="h-3 w-3/5" />
      </div>
    </div>
  ),
});
