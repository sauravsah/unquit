"use client";

import { motion } from "framer-motion";
import { Check, Mail, Monitor, Moon, Sun } from "lucide-react";
import Link from "next/link";
import { useTheme } from "next-themes";
import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import { useOptimisticValue } from "@/components/ui/use-optimistic";
import type { DunningSettings } from "@/lib/dunning/settings";

const THEMES = [
  { id: "light", label: "Light", icon: Sun },
  { id: "dark", label: "Dark", icon: Moon },
  { id: "system", label: "System", icon: Monitor },
] as const;

/** Theme picker with mini previews. Instant, saved in the browser. */
export function AppearancePanel() {
  const { theme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const current = mounted ? theme ?? "system" : "system";
  return (
    <div role="radiogroup" aria-label="Theme" className="grid grid-cols-3 gap-3">
      {THEMES.map(({ id, label, icon: Icon }) => {
        const active = current === id;
        return (
          <button
            key={id}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => setTheme(id)}
            className={cn(
              "group relative rounded-xl border p-2 text-left transition-[border-color,box-shadow] duration-200",
              active ? "border-brand shadow-glow-sm" : "border-border hover:border-input",
            )}
          >
            <span
              aria-hidden="true"
              className={cn(
                "block h-16 overflow-hidden rounded-lg border border-border",
                id === "light" && "bg-white",
                id === "dark" && "bg-zinc-950",
                id === "system" && "bg-[linear-gradient(110deg,#fff_50%,#09090b_50%)]",
              )}
            >
              <span className={cn("ml-2 mt-2 block h-1.5 w-10 rounded-full", id === "dark" ? "bg-zinc-700" : "bg-zinc-200")} />
              <span className={cn("ml-2 mt-1.5 block h-1.5 w-16 rounded-full", id === "dark" ? "bg-zinc-800" : "bg-zinc-100")} />
              <span className="ml-2 mt-2.5 block h-3 w-8 rounded bg-brand" />
            </span>
            <span className="mt-2 flex items-center gap-1.5 px-1 text-sm font-medium text-foreground">
              <Icon className="h-3.5 w-3.5 text-muted-foreground" /> {label}
            </span>
            {active ? (
              <motion.span
                layoutId="theme-check"
                className="absolute right-3 top-3 flex h-5 w-5 items-center justify-center rounded-full bg-brand text-white shadow-glow-sm"
              >
                <Check className="h-3 w-3" />
              </motion.span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}

/** Failed-payment emails on/off, saved optimistically through the existing settings API. */
export function EmailsTogglePanel({ initial }: { initial: DunningSettings }) {
  const [enabled, setEnabled, pending] = useOptimisticValue(
    initial.enabled,
    async (next) => {
      const res = await fetch("/api/dunning/settings", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...initial, enabled: next }),
      });
      const json = (await res.json().catch(() => ({}))) as { errors?: string[] };
      if (!res.ok) throw new Error(json.errors?.join(" ") ?? "Saving failed. Please try again.");
    },
    { success: (next) => (next ? "Failed-payment emails are on" : "Failed-payment emails are off") },
  );
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="flex items-start gap-3">
        <span className="mt-0.5 flex h-8 w-8 items-center justify-center rounded-lg border border-border bg-muted">
          <Mail className="h-4 w-4 text-muted-foreground" />
        </span>
        <div>
          <p className="flex items-center gap-2 text-sm font-medium text-foreground" id="emails-toggle-label">
            Email customers when a payment fails
            <Badge tone={enabled ? "success" : "neutral"} dot>
              {enabled ? "On" : "Off"}
            </Badge>
          </p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Three emails with a card-update link.{" "}
            <Link href="/dashboard/dunning" className="font-medium text-brand-text hover:underline">
              Edit the emails →
            </Link>
          </p>
        </div>
      </div>
      <Switch checked={enabled} onCheckedChange={(v) => void setEnabled(v)} disabled={pending} aria-labelledby="emails-toggle-label" />
    </div>
  );
}

/** Disconnect with a confirmation step. Posts to the existing route. */
export function DisconnectStripeButton() {
  const [busy, setBusy] = useState(false);
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button variant="secondary" size="sm">
          Disconnect
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Disconnect Stripe?</DialogTitle>
          <DialogDescription>
            unquit loses access straight away: the cancel flow stops applying offers and failed payments are no longer chased. Your
            ledger and receipts stay.
          </DialogDescription>
        </DialogHeader>
        <form action="/api/stripe/disconnect" method="post" onSubmit={() => setBusy(true)} className="flex justify-end gap-2">
          <DialogClose asChild>
            <Button type="button" variant="secondary">
              Keep connected
            </Button>
          </DialogClose>
          <Button type="submit" variant="danger" loading={busy}>
            Disconnect
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
