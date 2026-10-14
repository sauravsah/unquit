"use client";

import { FlaskConical, KeyRound, Lock } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { cn } from "@/components/ui/cn";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { Snippet } from "@/lib/install/snippets";
import { CodeBlock, CopyButton } from "./CodeBlock";

export type DeveloperGuideSnippets = Record<"script" | "env" | "node" | "python" | "frontend", Snippet>;

/**
 * The developer instructions, shared by /dashboard/install (audience "founder")
 * and the public /install/<token> page (audience "developer"). Shows the
 * publishable key only; the signing secret is always the `uqsk_...` placeholder.
 */
export function DeveloperGuide({
  snippets,
  publishableKey,
  audience,
  className,
}: {
  snippets: DeveloperGuideSnippets;
  publishableKey: string;
  audience: "founder" | "developer";
  className?: string;
}) {
  const [lang, setLang] = useState("node");
  return (
    <div className={cn("space-y-8", className)}>
      <div className="grid gap-3 sm:grid-cols-2">
        <KeyNote
          icon={<KeyRound className="h-4 w-4 text-brand-text" />}
          title="Publishable key · public"
          body="Goes in the script tag. Safe to put in a web page."
          extra={
            <div className="mt-2 flex items-center gap-1 rounded-lg border border-border bg-muted/50 py-1 pl-3 pr-1">
              <code className="min-w-0 flex-1 truncate font-mono text-xs text-foreground">{publishableKey}</code>
              <CopyButton text={publishableKey} what="the publishable key" />
            </div>
          }
        />
        <KeyNote
          icon={<Lock className="h-4 w-4 text-warning" />}
          title="Signing secret · server only"
          body={
            audience === "founder" ? (
              <>
                Starts with <code className="font-mono">uqsk_</code>. Copy it from{" "}
                <Link href="/dashboard#keys-title" className="font-medium text-brand-text hover:underline">
                  Overview → Widget keys
                </Link>{" "}
                and send it to your developer separately (a password manager or a direct message), never in this link.
              </>
            ) : (
              <>
                Starts with <code className="font-mono">uqsk_</code>. It isn&apos;t on this page on purpose: ask the founder for it (it&apos;s
                in their Unquit dashboard under Overview → Widget keys). Treat it like a password: server only.
              </>
            )
          }
        />
      </div>

      <GuideStep n={1} title="Add the script" body="Put this on every page that has a Cancel button (in the <head> or before </body>).">
        <CodeBlock {...snippets.script} />
      </GuideStep>

      <GuideStep
        n={2}
        title="Sign the customer on your server"
        body={
          <>
            Your backend already knows which Stripe customer and subscription the signed-in user owns. Add one endpoint that signs them, so
            nobody can open the cancel flow for someone else&apos;s subscription. The signature is HMAC-SHA256 of{" "}
            <code className="rounded border border-border bg-muted px-1 font-mono text-2xs">customerId:subscriptionId</code> (with a colon)
            using the signing secret, as lowercase hex.
          </>
        }
      >
        <CodeBlock {...snippets.env} />
        <Tabs value={lang} onValueChange={setLang} variant="pill" className="mt-4">
          <TabsList className="w-fit">
            <TabsTrigger value="node">Node.js</TabsTrigger>
            <TabsTrigger value="python">Python</TabsTrigger>
          </TabsList>
          <TabsContent value="node">
            <CodeBlock {...snippets.node} />
          </TabsContent>
          <TabsContent value="python">
            <CodeBlock {...snippets.python} />
          </TabsContent>
        </Tabs>
      </GuideStep>

      <GuideStep
        n={3}
        title="Open the flow when the user clicks Cancel"
        body={
          <>
            Change <code className="rounded border border-border bg-muted px-1 font-mono text-2xs">#cancel-button</code> to your own button.
            Unquit applies the offer or the cancellation directly in Stripe, so there is nothing else to wire up.
          </>
        }
      >
        <CodeBlock {...snippets.frontend} />
      </GuideStep>

      <div className="flex items-start gap-3 rounded-xl border border-brand/25 bg-brand-soft/60 px-4 py-3.5">
        <FlaskConical className="mt-0.5 h-4 w-4 shrink-0 text-brand-text" aria-hidden="true" />
        <p className="text-sm text-foreground">
          <span className="font-medium">How to test: </span>
          {audience === "founder" ? (
            <>
              open{" "}
              <Link href="/dashboard/test" className="font-medium text-brand-text hover:underline">
                Test the widget
              </Link>{" "}
              and try it with a Stripe <strong className="font-medium">test-mode</strong> customer. Accepting an offer really applies it in
              Stripe, and cancelling really cancels, so don&apos;t use a real customer.
            </>
          ) : (
            <>
              click your Cancel button as a user on a Stripe <strong className="font-medium">test-mode</strong> subscription. Accepting an
              offer really applies it in Stripe, and cancelling really cancels. The founder can also try the widget on its own under
              Dashboard → Test the widget.
            </>
          )}
        </p>
      </div>
    </div>
  );
}

function KeyNote({ icon, title, body, extra }: { icon: React.ReactNode; title: string; body: React.ReactNode; extra?: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-border bg-card p-4 shadow-xs">
      <div className="flex items-center gap-2">
        {icon}
        <h3 className="text-2xs font-medium uppercase tracking-wider text-muted-foreground">{title}</h3>
      </div>
      <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">{body}</p>
      {extra}
    </div>
  );
}

function GuideStep({ n, title, body, children }: { n: number; title: string; body: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="grid gap-3 sm:grid-cols-[2rem_minmax(0,1fr)]">
      <span className="flex h-7 w-7 items-center justify-center rounded-full border border-brand/40 bg-brand-soft text-xs font-semibold text-brand-text">
        {n}
      </span>
      <div className="min-w-0">
        <h3 className="text-sm font-semibold text-foreground">{title}</h3>
        <p className="mt-1 max-w-3xl text-sm leading-relaxed text-muted-foreground">{body}</p>
        <div className="mt-3">{children}</div>
      </div>
    </section>
  );
}
