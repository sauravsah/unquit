"use client";

import { useState } from "react";
import type { WidgetOutcome } from "@/widget/types";

type UnquitGlobal = {
  open: (o: { customerId: string; subscriptionId: string; hmac: string }) => Promise<WidgetOutcome>;
  configure: (o: { publishableKey?: string; apiBase?: string }) => void;
};

const input =
  "mt-1 block w-full rounded-lg border border-neutral-300 bg-white px-3 py-2 font-mono text-sm text-ink focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/30";

/** Loads /widget.js once, the same way a founder's site does. */
function loadWidget(publishableKey: string): Promise<UnquitGlobal> {
  const w = window as unknown as { Unquit?: UnquitGlobal };
  if (w.Unquit) {
    w.Unquit.configure({ publishableKey });
    return Promise.resolve(w.Unquit);
  }
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "/widget.js";
    script.async = true;
    script.dataset.unquitKey = publishableKey;
    script.onload = () => (w.Unquit ? resolve(w.Unquit) : reject(new Error("widget.js loaded but Unquit is missing")));
    script.onerror = () => reject(new Error("Couldn't load /widget.js. Run `npm run build:widget`."));
    document.head.appendChild(script);
  });
}

export function WidgetTester({ livemode }: { livemode: boolean | null }) {
  const [customerId, setCustomerId] = useState("");
  const [subscriptionId, setSubscriptionId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [log, setLog] = useState<string[]>([]);

  async function open(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/dashboard/test-signature", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ customerId: customerId.trim(), subscriptionId: subscriptionId.trim() }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string; hmac?: string; publishableKey?: string };
      if (!res.ok || !data.hmac || !data.publishableKey) throw new Error(data.error ?? "Couldn't sign this customer.");
      const unquit = await loadWidget(data.publishableKey);
      setBusy(false);
      const outcome = await unquit.open({ customerId: customerId.trim(), subscriptionId: subscriptionId.trim(), hmac: data.hmac });
      setLog((l) => [`${new Date().toLocaleTimeString()}  ${JSON.stringify(outcome)}`, ...l].slice(0, 10));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid gap-8 lg:grid-cols-2">
      <form onSubmit={open} className="rounded-xl border border-neutral-200 bg-white p-5">
        {livemode ? (
          <p role="note" className="mb-4 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
            Your Stripe account is connected in live mode. Live subscriptions are refused here; connect a test-mode account to try
            the widget.
          </p>
        ) : null}
        <label className="block text-sm font-medium text-ink">
          Test customer id
          <input
            className={input}
            placeholder="cus_…"
            value={customerId}
            onChange={(e) => setCustomerId(e.target.value)}
            required
            autoComplete="off"
          />
        </label>
        <label className="mt-4 block text-sm font-medium text-ink">
          Their subscription id
          <input
            className={input}
            placeholder="sub_…"
            value={subscriptionId}
            onChange={(e) => setSubscriptionId(e.target.value)}
            required
            autoComplete="off"
          />
        </label>
        <p className="mt-2 text-xs text-neutral-500">
          In Stripe (test mode), open Customers, create a customer with a subscription, and copy both ids.
        </p>
        {error ? (
          <p role="alert" className="mt-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
            {error}
          </p>
        ) : null}
        <button
          type="submit"
          disabled={busy}
          className="mt-5 rounded-lg bg-brand px-5 py-2.5 text-sm font-semibold text-white hover:bg-brand-dark disabled:opacity-60"
        >
          {busy ? "Opening…" : "Open cancel flow"}
        </button>
      </form>

      <section className="rounded-xl border border-neutral-200 bg-white p-5">
        <h2 className="text-base font-semibold text-ink">Results</h2>
        <p className="mt-1 text-sm text-neutral-500">
          What <code className="rounded bg-neutral-100 px-1">Unquit.open()</code> resolved with. Accepted offers appear in your
          ledger as <em>pending</em> until the customer&apos;s next invoice is paid.
        </p>
        {log.length === 0 ? (
          <p className="mt-6 text-sm text-neutral-400">Nothing yet.</p>
        ) : (
          <ul className="mt-4 space-y-2">
            {log.map((line) => (
              <li key={line} className="break-all rounded-lg bg-neutral-100 px-3 py-2 font-mono text-xs text-ink">
                {line}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
