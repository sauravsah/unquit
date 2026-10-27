"use client";

import { AnimatePresence, motion } from "framer-motion";
import { FlaskConical, Play, Terminal, TriangleAlert, UserPlus } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Field, Input } from "@/components/ui/input";
import { toast } from "@/components/ui/toast";
import type { WidgetOutcome } from "@/widget/types";

type UnquitGlobal = {
  open: (o: { customerId: string; subscriptionId: string; hmac: string }) => Promise<WidgetOutcome>;
  configure: (o: { publishableKey?: string; apiBase?: string }) => void;
};

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
  const [fixtureBusy, setFixtureBusy] = useState(false);
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
      if (outcome.outcome === "saved") toast.success("Offer accepted", { description: "It appears in your ledger as pending." });
      else if (outcome.outcome === "canceled") toast("Subscription cancelled in Stripe");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function createFixture() {
    setFixtureBusy(true);
    setError("");
    try {
      const res = await fetch("/api/dashboard/test-fixture", { method: "POST" });
      const data = (await res.json().catch(() => ({}))) as { error?: string; customerId?: string; subscriptionId?: string };
      if (!res.ok || !data.customerId || !data.subscriptionId) throw new Error(data.error ?? "Couldn't create the test customer.");
      setCustomerId(data.customerId);
      setSubscriptionId(data.subscriptionId);
      toast.success("Test customer ready", { description: "A 30-day trial was created in Stripe test mode." });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setFixtureBusy(false);
    }
  }

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <Card>
        <CardHeader>
          <div className="flex items-start gap-3">
            <span className="mt-0.5 flex h-8 w-8 items-center justify-center rounded-lg border border-border bg-muted">
              <FlaskConical className="h-4 w-4 text-muted-foreground" />
            </span>
            <div>
              <CardTitle>Test customer</CardTitle>
              <CardDescription>
                Don&apos;t have Stripe access? Create a safe 30-day trial here, then open the real widget against it.
              </CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <form onSubmit={open} className="space-y-4">
            {livemode ? (
              <p role="note" className="flex gap-2.5 rounded-xl border border-warning/30 bg-warning-soft px-3.5 py-3 text-sm text-warning">
                <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" />
                Your Stripe account is connected in live mode. Live subscriptions are refused here; connect a test-mode account to try the
                widget.
              </p>
            ) : null}
            <div className="rounded-xl border border-border bg-muted/40 p-3.5">
              <p className="text-sm text-muted-foreground">No card or real payment is used. This is available only for your connected test-mode account.</p>
              <Button type="button" variant="outline" className="mt-3" loading={fixtureBusy} onClick={createFixture}>
                <UserPlus className="h-4 w-4" /> Create safe test customer
              </Button>
            </div>
            <Field label="Test customer id">
              <Input
                className="font-mono"
                placeholder="cus_…"
                value={customerId}
                onChange={(e) => setCustomerId(e.target.value)}
                required
                autoComplete="off"
              />
            </Field>
            <Field label="Their subscription id">
              <Input
                className="font-mono"
                placeholder="sub_…"
                value={subscriptionId}
                onChange={(e) => setSubscriptionId(e.target.value)}
                required
                autoComplete="off"
              />
            </Field>
            <AnimatePresence>
              {error ? (
                <motion.p
                  role="alert"
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: "auto" }}
                  exit={{ opacity: 0, height: 0 }}
                  className="overflow-hidden rounded-xl border border-danger/30 bg-danger-soft px-3.5 py-3 text-sm text-danger"
                >
                  {error}
                </motion.p>
              ) : null}
            </AnimatePresence>
            <Button type="submit" variant="brand" loading={busy}>
              <Play className="h-4 w-4" /> Open cancel flow
            </Button>
          </form>
        </CardContent>
      </Card>

      <Card className="overflow-hidden">
        <CardHeader>
          <div className="flex items-start gap-3">
            <span className="mt-0.5 flex h-8 w-8 items-center justify-center rounded-lg border border-border bg-muted">
              <Terminal className="h-4 w-4 text-muted-foreground" />
            </span>
            <div>
              <CardTitle>Results</CardTitle>
              <CardDescription>
                What <code className="rounded bg-muted px-1 font-mono">Unquit.open()</code> resolved with. Accepted offers appear in your ledger
                as <em>pending</em> until the customer&apos;s next invoice is paid.
              </CardDescription>
            </div>
          </div>
        </CardHeader>
        {log.length === 0 ? (
          <EmptyState compact art="flow" title="Nothing yet" description="Open the flow on a test customer and the result lands here." />
        ) : (
          <ul className="max-h-[360px] space-y-1.5 overflow-y-auto bg-zinc-950 p-4 font-mono text-xs text-zinc-100">
            <AnimatePresence initial={false}>
              {log.map((line) => (
                <motion.li
                  key={line}
                  layout
                  initial={{ opacity: 0, y: -6 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="break-all rounded-md px-2 py-1.5 hover:bg-white/5"
                >
                  <span className="text-emerald-400">›</span> {line}
                </motion.li>
              ))}
            </AnimatePresence>
          </ul>
        )}
      </Card>
    </div>
  );
}
