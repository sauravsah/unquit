"use client";

import { AnimatePresence, motion } from "framer-motion";
import { CircleCheck, CircleSlash, CreditCard, Hourglass, MousePointerClick, RotateCcw } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import useSWR from "swr";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/components/ui/cn";
import { EmptyState } from "@/components/ui/empty-state";
import { formatNumber } from "@/components/ui/number-ticker";
import { createSupabaseBrowserClient } from "@/lib/supabase/browser";
import {
  CASE_COLUMNS,
  SAVE_COLUMNS,
  SESSION_COLUMNS,
  buildActivity,
  timeAgo,
  type ActivityItem,
  type ActivityKind,
  type CaseActivityRow,
  type SaveActivityRow,
  type SessionActivityRow,
} from "./activity";

const TABLES = ["saves", "cancel_sessions", "dunning_cases"] as const;
const POLL_MS = 15_000;

type Mode = "connecting" | "live" | "polling";

function client() {
  try {
    return createSupabaseBrowserClient();
  } catch {
    return null; // Supabase not configured in this environment
  }
}

async function fetchActivity(accountId: string): Promise<ActivityItem[]> {
  const supabase = client();
  if (!supabase) throw new Error("Supabase is not configured");
  // RLS limits every query to the signed-in founder's account.
  const [saves, sessions, cases] = await Promise.all([
    supabase.from("saves").select(SAVE_COLUMNS).eq("account_id", accountId).order("created_at", { ascending: false }).limit(15),
    supabase.from("cancel_sessions").select(SESSION_COLUMNS).eq("account_id", accountId).order("started_at", { ascending: false }).limit(15),
    supabase.from("dunning_cases").select(CASE_COLUMNS).eq("account_id", accountId).order("opened_at", { ascending: false }).limit(15),
  ]);
  const err = saves.error ?? sessions.error ?? cases.error;
  if (err) throw new Error(err.message);
  return buildActivity(
    (saves.data ?? []) as SaveActivityRow[],
    (sessions.data ?? []) as SessionActivityRow[],
    (cases.data ?? []) as CaseActivityRow[],
  );
}

/**
 * Live feed of saves, cancels and recoveries. Subscribes to Supabase Realtime
 * on the three tables (filtered to this account; RLS applies) and refetches
 * on every change. If Realtime isn't available it polls every 15 seconds.
 * Any change also refreshes the server-rendered stats and charts.
 */
export function LiveActivity({ accountId, initial }: { accountId: string; initial: ActivityItem[] }) {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>("connecting");
  const refreshTimer = useRef<ReturnType<typeof setTimeout>>();
  const { data, mutate } = useSWR(["activity", accountId], () => fetchActivity(accountId), {
    fallbackData: initial,
    refreshInterval: mode === "live" ? 0 : POLL_MS,
    revalidateOnMount: false,
    revalidateOnFocus: true,
    keepPreviousData: true,
  });

  // Previous ids, to flag rows that arrived after first paint.
  const seen = useRef<Set<string>>(new Set(initial.map((i) => i.id)));
  const items = useMemo(() => data ?? [], [data]);
  const fresh = useMemo(() => new Set(items.filter((i) => !seen.current.has(i.id)).map((i) => i.id)), [items]);
  useEffect(() => {
    if (fresh.size === 0) return;
    // A new event: refresh the server-rendered numbers too (debounced).
    clearTimeout(refreshTimer.current);
    refreshTimer.current = setTimeout(() => router.refresh(), 800);
    const t = setTimeout(() => items.forEach((i) => seen.current.add(i.id)), 2400);
    return () => clearTimeout(t);
  }, [fresh, items, router]);

  useEffect(() => {
    const supabase = client();
    if (!supabase) {
      setMode("polling");
      return;
    }
    const channel = supabase.channel(`overview:${accountId}`);
    for (const table of TABLES) {
      channel.on("postgres_changes", { event: "*", schema: "public", table, filter: `account_id=eq.${accountId}` }, () => {
        void mutate();
      });
    }
    const fallback = setTimeout(() => setMode((m) => (m === "connecting" ? "polling" : m)), 6000);
    channel.subscribe((status) => {
      if (status === "SUBSCRIBED") setMode("live");
      else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") setMode("polling");
    });
    return () => {
      clearTimeout(fallback);
      void supabase.removeChannel(channel);
    };
  }, [accountId, mutate]);

  useEffect(() => () => clearTimeout(refreshTimer.current), []);

  // Re-render relative times every 30s.
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 30_000);
    return () => clearInterval(t);
  }, []);

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between gap-2 border-b border-border px-5 py-4">
        <div>
          <h2 className="text-sm font-semibold tracking-tight text-foreground">Live activity</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">Saves, cancels and recoveries as they happen</p>
        </div>
        <Badge tone={mode === "live" ? "success" : "neutral"} dot={mode === "live" ? "pulse" : true} aria-live="polite">
          {mode === "live" ? "Live" : mode === "connecting" ? "Connecting" : "Auto-refresh"}
        </Badge>
      </div>
      {items.length === 0 ? (
        <EmptyState
          compact
          art="pulse"
          title="Waiting for the first event"
          description="When a customer opens your cancel flow or a payment fails, it appears here instantly."
        />
      ) : (
        <ol className="relative max-h-[460px] flex-1 overflow-y-auto px-5 py-3" aria-label="Recent activity">
          <span aria-hidden="true" className="absolute bottom-5 left-[33px] top-5 w-px bg-border" />
          <AnimatePresence initial={false}>
            {items.map((item) => (
              <motion.li
                key={item.id}
                layout="position"
                initial={{ opacity: 0, x: -8, scale: 0.98 }}
                animate={{ opacity: 1, x: 0, scale: 1 }}
                exit={{ opacity: 0 }}
                transition={{ type: "spring", stiffness: 380, damping: 30 }}
                className={cn("relative flex gap-3 rounded-lg py-2.5 pr-1", fresh.has(item.id) && "animate-[row-flash_2.4s_ease-out]")}
              >
                <KindIcon kind={item.kind} />
                <div className="min-w-0 flex-1">
                  <p className="flex items-baseline justify-between gap-2 text-sm">
                    <span className="truncate font-medium text-foreground">{item.title}</span>
                    {item.amountCents !== null ? (
                      <span className={cn("shrink-0 text-xs font-medium tabular-nums", item.kind === "save" || item.kind === "recovery" ? "text-brand-text" : "text-muted-foreground")}>
                        {item.kind === "save" || item.kind === "recovery" ? "+" : ""}
                        {formatNumber(item.amountCents, "cents", item.currency)}
                        {item.per}
                      </span>
                    ) : null}
                  </p>
                  <p className="mt-0.5 flex items-center justify-between gap-2 text-xs text-muted-foreground">
                    <span className="truncate">{item.detail}</span>
                    <time dateTime={item.at} className="shrink-0 text-subtle">
                      {timeAgo(item.at)}
                    </time>
                  </p>
                </div>
              </motion.li>
            ))}
          </AnimatePresence>
        </ol>
      )}
    </div>
  );
}

const KIND: Record<ActivityKind, { icon: typeof CircleCheck; className: string }> = {
  save: { icon: CircleCheck, className: "bg-brand-soft text-brand-text border-brand/30" },
  recovery: { icon: RotateCcw, className: "bg-brand-soft text-brand-text border-brand/30" },
  pending: { icon: Hourglass, className: "bg-muted text-muted-foreground border-border" },
  session: { icon: MousePointerClick, className: "bg-muted text-muted-foreground border-border" },
  cancel: { icon: CircleSlash, className: "bg-muted text-muted-foreground border-border" },
  failed: { icon: CreditCard, className: "bg-warning-soft text-warning border-warning/30" },
};

function KindIcon({ kind }: { kind: ActivityKind }) {
  const { icon: Icon, className } = KIND[kind];
  return (
    <span className={cn("relative z-10 mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border", className)}>
      <Icon className="h-3.5 w-3.5" aria-hidden="true" />
    </span>
  );
}
