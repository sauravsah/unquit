"use client";

import { KeyRound, Lock } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export type PermissionRow = { id: string; section: string; resource: string; level: string; why: string };

/**
 * "Connect with a Stripe restricted key": exact steps, the permission list
 * (derived from REQUIRED_PERMISSIONS on the server) and the paste form. The
 * key goes to /api/stripe/key once and never comes back to the browser.
 */
export function RestrictedKeyConnect({ permissions, optional }: { permissions: PermissionRow[]; optional: PermissionRow }) {
  const router = useRouter();
  const [restrictedKey, setRestrictedKey] = useState("");
  const [publishableKey, setPublishableKey] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<{ message: string; missing: { id: string; resource: string; level: string }[] } | null>(null);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);
    try {
      const res = await fetch("/api/stripe/key", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ restrictedKey: restrictedKey.trim(), publishableKey: publishableKey.trim() }),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string; missing?: { id: string; resource: string; level: string }[] };
      if (!res.ok) {
        setError({ message: body.error ?? "Couldn’t connect. Please try again.", missing: body.missing ?? [] });
        setPending(false);
        return;
      }
      setRestrictedKey("");
      router.replace("/dashboard?stripe=connected_key");
      router.refresh();
    } catch {
      setError({ message: "Couldn’t reach the server. Check your connection and try again.", missing: [] });
      setPending(false);
    }
  }

  const missingIds = new Set(error?.missing.map((m) => m.id));
  const sections = Array.from(new Set(permissions.map((p) => p.section)));

  return (
    <section id="restricted-key" className="rounded-2xl border border-border bg-card p-6 shadow-card sm:p-8">
      <div className="flex items-start gap-3">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-border bg-background">
          <KeyRound className="h-4 w-4 text-brand-text" />
        </span>
        <div>
          <h2 className="text-xl font-semibold tracking-tight text-foreground">Connect with a Stripe restricted key</h2>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            Can’t use Stripe Connect (for example, Stripe accounts in India)? Create a restricted key that can do only what Unquit needs and
            paste it here. It takes about 3 minutes.
          </p>
        </div>
      </div>

      <ol className="mt-6 space-y-4 text-sm text-muted-foreground [&_strong]:font-medium [&_strong]:text-foreground">
        <li className="flex gap-3">
          <Step n={1} />
          <span>
            In Stripe, open <strong>Developers → API keys</strong>. Use the <strong>Test mode</strong> switch first if you want to try it on test
            data.
          </span>
        </li>
        <li className="flex gap-3">
          <Step n={2} />
          <span>
            Click <strong>Create restricted key</strong> (if Stripe asks how you’ll use it, choose <strong>Building your own integration</strong>)
            and name it <strong>Unquit</strong>.
          </span>
        </li>
        <li className="flex gap-3">
          <Step n={3} />
          <div className="min-w-0 flex-1">
            <span>
              Set exactly these permissions. Leave everything else on <strong>None</strong>.
            </span>
            <div className="mt-3 overflow-hidden rounded-xl border border-border">
              <table className="w-full text-left text-sm">
                <thead className="bg-muted/60 text-2xs uppercase tracking-wider text-muted-foreground">
                  <tr>
                    <th scope="col" className="px-3 py-2 font-medium">Resource</th>
                    <th scope="col" className="px-3 py-2 font-medium">Permission</th>
                    <th scope="col" className="hidden px-3 py-2 font-medium md:table-cell">Why Unquit needs it</th>
                  </tr>
                </thead>
                {sections.map((section) => (
                  <tbody key={section} className="divide-y divide-border border-t border-border">
                    <tr>
                      <th colSpan={3} scope="colgroup" className="bg-background px-3 py-1.5 text-2xs font-semibold uppercase tracking-wider text-subtle">
                        {section}
                      </th>
                    </tr>
                    {permissions
                      .filter((p) => p.section === section)
                      .map((p) => (
                        <tr key={p.id} className={missingIds.has(p.id) ? "bg-danger-soft" : undefined}>
                          <td className="px-3 py-2 font-medium text-foreground">{p.resource}</td>
                          <td className="px-3 py-2">
                            <span className="rounded-md border border-border bg-muted px-1.5 py-0.5 font-mono text-xs text-foreground">{p.level}</span>
                            {missingIds.has(p.id) ? <span className="ml-2 text-xs font-medium text-danger">missing</span> : null}
                          </td>
                          <td className="hidden px-3 py-2 text-muted-foreground md:table-cell">{p.why}</td>
                        </tr>
                      ))}
                  </tbody>
                ))}
              </table>
            </div>
            <p className="mt-2 text-xs">
              Optional: <strong>{optional.section} → {optional.resource}: {optional.level}</strong> lets Unquit read your account id directly.
              Without it Unquit reads it from Stripe’s reply instead.
            </p>
          </div>
        </li>
        <li className="flex gap-3">
          <Step n={4} />
          <span>
            Click <strong>Create key</strong> and copy it (it starts with <code className="font-mono text-xs text-foreground">rk_</code>). Also copy the{" "}
            <strong>Publishable key</strong> from the same page (<code className="font-mono text-xs text-foreground">pk_</code>): your customers’
            card-update page needs it for Stripe’s secure card form.
          </span>
        </li>
        <li className="flex gap-3">
          <Step n={5} />
          <span>
            Paste both below. Unquit checks every permission (without changing anything), adds one webhook endpoint called{" "}
            <strong>Unquit churn recovery</strong> under Developers → Webhooks, and stores the key encrypted. You’ll only ever see its last 4
            characters again.
          </span>
        </li>
      </ol>

      <form onSubmit={onSubmit} className="mt-6 grid gap-4 sm:grid-cols-2" autoComplete="off">
        <label className="block">
          <span className="text-sm font-medium text-foreground">Restricted key</span>
          <Input
            type="password"
            name="restrictedKey"
            required
            spellCheck={false}
            autoComplete="off"
            value={restrictedKey}
            onChange={(e) => setRestrictedKey(e.target.value)}
            placeholder="rk_live_… or rk_test_…"
            className="mt-1.5 h-10 font-mono"
            aria-invalid={error ? true : undefined}
          />
        </label>
        <label className="block">
          <span className="text-sm font-medium text-foreground">Publishable key</span>
          <Input
            type="text"
            name="publishableKey"
            required
            spellCheck={false}
            autoComplete="off"
            value={publishableKey}
            onChange={(e) => setPublishableKey(e.target.value)}
            placeholder="pk_live_… or pk_test_…"
            className="mt-1.5 h-10 font-mono"
          />
        </label>
        <div className="flex flex-wrap items-center gap-3 sm:col-span-2">
          <Button type="submit" variant="brand" loading={pending}>
            Check key and connect
          </Button>
          <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Lock className="h-3.5 w-3.5" /> Encrypted at rest. Revoke it in Stripe or disconnect here any time.
          </span>
        </div>
        {error ? (
          <p role="alert" className="rounded-xl border border-danger/30 bg-danger-soft px-4 py-3 text-sm text-danger sm:col-span-2">
            {error.message}
          </p>
        ) : null}
      </form>
    </section>
  );
}

function Step({ n }: { n: number }) {
  return (
    <span aria-hidden="true" className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-border bg-background text-xs font-semibold text-foreground">
      {n}
    </span>
  );
}
