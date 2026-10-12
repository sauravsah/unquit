"use client";

import { useState, type FormEvent } from "react";
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

  if (status.kind === "sent") {
    return (
      <div className="mt-8 rounded-lg border border-brand/30 bg-brand-light px-4 py-3 text-sm text-ink">
        Check <span className="font-medium">{status.email}</span> for your sign-in link. You can close this tab.
      </div>
    );
  }

  return (
    <form onSubmit={onSubmit} className="mt-8 space-y-4">
      <label className="block">
        <span className="text-sm font-medium text-ink">Work email</span>
        <input
          type="email"
          required
          autoComplete="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@company.com"
          className="mt-1 block w-full rounded-lg border border-neutral-300 px-3 py-2 text-sm text-ink placeholder:text-neutral-400 focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand"
        />
      </label>
      <button
        type="submit"
        disabled={status.kind === "sending"}
        className="w-full rounded-lg bg-brand px-4 py-2.5 text-sm font-semibold text-white hover:bg-brand-dark disabled:opacity-60"
      >
        {status.kind === "sending" ? "Sending…" : "Email me a sign-in link"}
      </button>
      {status.kind === "error" ? (
        <p role="alert" className="text-sm text-red-600">
          {status.message}
        </p>
      ) : null}
    </form>
  );
}
