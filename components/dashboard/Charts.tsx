"use client";

import { useState } from "react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  Cell,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { ReasonSlice, TrendPoint } from "@/app/dashboard/_lib/overview";
import { cn } from "@/components/ui/cn";

const money = (n: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(n);

/** Saved MRR and recovered payments per week. Loaded lazily (recharts is heavy). */
export function SavedMrrChart({ data }: { data: TrendPoint[] }) {
  return (
    <div className="h-[260px] w-full text-muted-foreground">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
          <defs>
            <linearGradient id="uq-saved" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#22C55E" stopOpacity={0.35} />
              <stop offset="100%" stopColor="#22C55E" stopOpacity={0} />
            </linearGradient>
            <linearGradient id="uq-recovered" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#71717A" stopOpacity={0.22} />
              <stop offset="100%" stopColor="#71717A" stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid vertical={false} stroke="currentColor" strokeOpacity={0.12} />
          <XAxis dataKey="label" tickLine={false} axisLine={false} tick={{ fill: "currentColor", fontSize: 11 }} interval="preserveStartEnd" minTickGap={24} />
          <YAxis tickLine={false} axisLine={false} width={48} tick={{ fill: "currentColor", fontSize: 11 }} tickFormatter={(v: number) => money(v)} />
          <Tooltip cursor={{ stroke: "currentColor", strokeOpacity: 0.25 }} content={<TrendTooltip />} />
          <Area type="monotone" dataKey="recovered" name="Recovered" stroke="#71717A" strokeWidth={1.5} fill="url(#uq-recovered)" animationDuration={900} />
          <Area type="monotone" dataKey="saved" name="Saved MRR" stroke="#16A34A" strokeWidth={2} fill="url(#uq-saved)" animationDuration={900} activeDot={{ r: 4, strokeWidth: 0, fill: "#22C55E" }} />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

type TipProps = { active?: boolean; payload?: { name?: string; value?: number; color?: string; stroke?: string }[]; label?: string };

function TrendTooltip({ active, payload, label }: TipProps) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-lg border border-border bg-popover px-3 py-2 text-xs shadow-float">
      <p className="font-medium text-foreground">Week of {label}</p>
      {payload.map((p) => (
        <p key={p.name} className="mt-1 flex items-center gap-2 text-muted-foreground">
          <span className="h-2 w-2 rounded-full" style={{ background: p.stroke ?? p.color }} />
          {p.name}
          <span className="ml-auto pl-3 font-medium tabular-nums text-foreground">{money(Number(p.value ?? 0))}</span>
        </p>
      ))}
    </div>
  );
}

const SLICE_COLORS = ["#16A34A", "#22C55E", "#4ADE80", "#86EFAC", "#A1A1AA", "#52525B"];

/** Why customers try to cancel (last 90 days). */
export function ReasonsDonut({ data }: { data: ReasonSlice[] }) {
  const [active, setActive] = useState<number | null>(null);
  const total = data.reduce((n, d) => n + d.count, 0);
  const focus = active !== null ? data[active] : undefined;
  return (
    <div className="flex flex-col items-center gap-5 sm:flex-row lg:flex-col xl:flex-row">
      <div className="relative h-[168px] w-[168px] shrink-0">
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie
              data={data}
              dataKey="count"
              nameKey="reason"
              innerRadius={56}
              outerRadius={80}
              paddingAngle={2}
              stroke="none"
              animationDuration={800}
              onMouseEnter={(_: unknown, i: number) => setActive(i)}
              onMouseLeave={() => setActive(null)}
            >
              {data.map((d, i) => (
                <Cell key={d.reason} fill={SLICE_COLORS[i % SLICE_COLORS.length]} opacity={active === null || active === i ? 1 : 0.35} />
              ))}
            </Pie>
          </PieChart>
        </ResponsiveContainer>
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center text-center">
          <span className="text-xl font-semibold tabular-nums text-foreground">{focus ? focus.count : total}</span>
          <span className="max-w-[90px] truncate text-2xs text-muted-foreground">{focus ? focus.reason : "attempts"}</span>
        </div>
      </div>
      <ul className="w-full min-w-0 space-y-1.5">
        {data.map((d, i) => (
          <li
            key={d.reason}
            onMouseEnter={() => setActive(i)}
            onMouseLeave={() => setActive(null)}
            className={cn("flex items-center gap-2 rounded-md px-1.5 py-1 text-xs transition-colors", active === i && "bg-muted")}
          >
            <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: SLICE_COLORS[i % SLICE_COLORS.length] }} />
            <span className="min-w-0 flex-1 break-words leading-snug text-foreground" title={d.reason}>
              {d.reason}
            </span>
            <span className="tabular-nums text-muted-foreground">{Math.round((d.count / total) * 100)}%</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
