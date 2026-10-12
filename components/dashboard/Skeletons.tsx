import { Skeleton } from "@/components/ui/skeleton";

/** Route-level loading states. Each mirrors its page's layout so nothing jumps when data arrives. */

export function HeaderSkeleton() {
  return (
    <div className="mb-8 space-y-2">
      <Skeleton className="h-7 w-44" />
      <Skeleton className="h-4 w-80 max-w-full" />
    </div>
  );
}

export function StatsSkeleton() {
  return (
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
      {Array.from({ length: 4 }, (_, i) => (
        <div key={i} className="rounded-xl border border-border bg-card p-5 shadow-card">
          <Skeleton className="h-3 w-24" />
          <Skeleton className="mt-3 h-7 w-28" />
          <Skeleton className="mt-2.5 h-3 w-20" />
        </div>
      ))}
    </div>
  );
}

export function CardSkeleton({ rows = 5, className = "" }: { rows?: number; className?: string }) {
  return (
    <div className={`overflow-hidden rounded-xl border border-border bg-card shadow-card ${className}`}>
      <div className="border-b border-border px-5 py-4">
        <Skeleton className="h-4 w-32" />
        <Skeleton className="mt-2 h-3 w-52" />
      </div>
      <div className="divide-y divide-border">
        {Array.from({ length: rows }, (_, i) => (
          <div key={i} className="flex items-center gap-4 px-5 py-3.5">
            <Skeleton className="h-3 w-20" />
            <Skeleton className="h-3 flex-1" />
            <Skeleton className="h-5 w-16 rounded-full" />
          </div>
        ))}
      </div>
    </div>
  );
}

export function OverviewSkeleton() {
  return (
    <div className="space-y-6" aria-busy="true" aria-label="Loading overview">
      <HeaderSkeleton />
      <StatsSkeleton />
      <div className="grid gap-6 lg:grid-cols-3">
        <div className="rounded-xl border border-border bg-card p-5 shadow-card lg:col-span-2">
          <Skeleton className="h-4 w-40" />
          <Skeleton className="mt-6 h-[260px] w-full rounded-lg" />
        </div>
        <div className="rounded-xl border border-border bg-card p-5 shadow-card">
          <Skeleton className="h-4 w-36" />
          <Skeleton className="mx-auto mt-8 h-[168px] w-[168px] rounded-full" />
        </div>
      </div>
      <div className="grid gap-6 lg:grid-cols-3">
        <CardSkeleton className="lg:col-span-2" rows={6} />
        <CardSkeleton rows={6} />
      </div>
    </div>
  );
}

export function EditorSkeleton() {
  return (
    <div aria-busy="true" aria-label="Loading">
      <HeaderSkeleton />
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_420px]">
        <div className="space-y-6">
          <CardSkeleton rows={3} />
          <CardSkeleton rows={5} />
        </div>
        <div className="rounded-2xl border border-border bg-card p-4 shadow-card">
          <Skeleton className="h-4 w-28" />
          <Skeleton className="mt-4 h-[520px] w-full rounded-xl" />
        </div>
      </div>
    </div>
  );
}

export function TablePageSkeleton() {
  return (
    <div className="space-y-6" aria-busy="true" aria-label="Loading">
      <HeaderSkeleton />
      <StatsSkeleton />
      <CardSkeleton rows={8} />
    </div>
  );
}

export function FormPageSkeleton() {
  return (
    <div className="space-y-6" aria-busy="true" aria-label="Loading">
      <HeaderSkeleton />
      <div className="grid gap-6 lg:grid-cols-2">
        <CardSkeleton rows={4} />
        <CardSkeleton rows={4} />
      </div>
    </div>
  );
}
