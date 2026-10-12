"use client";

import { AnimatePresence, motion } from "framer-motion";
import { ArrowRight, MailCheck } from "lucide-react";
import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { createSupabaseBrowserClient } from "@/lib/supabase/browser";

type Status = { kind: "idle" } | { kind: "sending" } | { kind: "sent"; email: string } | { kind: "error"; message: string };

export function LoginForm({ next }: { next: string }) {
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState<Status>({ kind: "idle" });

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setStatus({ kind: "sending" });
    try {
      const supabase = createSupabaseBrowserClient();
      const appUrl = (process.env.NEXT_PUBLIC_APP_URL || window.location.origin).replace(/\/+$/, "");
      const safeNext = next.startsWith("/") && !next.startsWith("//") ? next : "/dashboard";
      const { error } = await supabase.auth.signInWithOtp({
        email: email.trim(),
        options: { emailRedirectTo: `${appUrl}/auth/callback?next=${encodeURIComponent(safeNext)}` },
      });
      if (error) throw error;
      setStatus({ kind: "sent", email: email.trim() });
    } catch (err) {
      setStatus({ kind: "error", message: err instanceof Error ? err.message : "Could not send the link." });
    }
  }

  return (
    <AnimatePresence mode="wait" initial={false}>
      {status.kind === "sent" ? (
        <motion.div
          key="sent"
          role="status"
          initial={{ opacity: 0, scale: 0.97, y: 6 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          className="mt-8 rounded-2xl border border-brand/30 bg-brand-soft p-5 text-sm text-foreground"
        >
          <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-brand text-white shadow-glow">
            <MailCheck className="h-5 w-5" />
          </span>
          <p className="mt-4 text-base font-semibold">Check your inbox</p>
          <p className="mt-1 text-muted-foreground">
            We sent a sign-in link to <span className="font-medium text-foreground">{status.email}</span>. You can close this tab.
          </p>
          <button
            type="button"
            onClick={() => setStatus({ kind: "idle" })}
            className="mt-4 text-xs font-medium text-brand-text underline-offset-4 hover:underline"
          >
            Use a different email
          </button>
        </motion.div>
      ) : (
        <motion.form key="form" onSubmit={onSubmit} exit={{ opacity: 0, y: -6 }} className="mt-8 space-y-4">
          <label className="block">
            <span className="text-sm font-medium text-foreground">Work email</span>
            <Input
              type="email"
              required
              autoComplete="email"
              autoFocus
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@company.com"
              className="mt-1.5 h-11"
              aria-invalid={status.kind === "error" || undefined}
            />
          </label>
          <Button type="submit" variant="primary" size="lg" className="group w-full" loading={status.kind === "sending"}>
            Email me a sign-in link
            <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
          </Button>
          {status.kind === "error" ? (
            <motion.p role="alert" initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} className="text-sm text-danger">
              {status.message}
            </motion.p>
          ) : null}
        </motion.form>
      )}
    </AnimatePresence>
  );
}
