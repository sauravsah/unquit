import { ArrowRight, Check, Code2, CreditCard, Plug, Wallet, Workflow } from "lucide-react";
import Link from "next/link";
import { redirect } from "next/navigation";
import { PageHeader } from "@/components/DashboardShell";
import { DeveloperGuide } from "@/components/install/DeveloperGuide";
import { ShareCard } from "@/components/install/ShareCard";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/components/ui/cn";
import { getOrCreateAccount, getWidgetKeys } from "@/lib/accounts";
import { getSessionUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db";
import { publicEnv } from "@/lib/env";
import { getInstallLinkToken } from "@/lib/install/repo";
import { buildSnippets, developerMessage } from "@/lib/install/snippets";
import { installLinkUrl } from "@/lib/install/token";
import { loadSetupStatus, type SetupStatus } from "../_lib/overview";

export const dynamic = "force-dynamic";

export const metadata = { title: "Setup guide · unquit" };

type Step = {
  id: string;
  title: string;
  who: string;
  body: string;
  done: boolean;
  icon: React.ComponentType<{ className?: string }>;
  links: { href: string; label: string; external?: boolean }[];
};

export default async function InstallGuidePage({ searchParams }: { searchParams: { link?: string } }) {
  const db = getDb();
  const user = await getSessionUser();
  if (!user) redirect("/login?next=/dashboard/install");

  const account = await getOrCreateAccount(db, user);
  const connected = account.stripe_connection_status === "connected" && !!account.stripe_account_id;
  const appUrl = publicEnv.appUrl();
  const [keys, token, status] = await Promise.all([
    getWidgetKeys(db, account.id),
    getInstallLinkToken(db, account.id),
    loadSetupStatus(db, account.id).catch((): SetupStatus => ({ flowSaved: false, widgetUsed: false, dunningOn: false, billingCard: false })),
  ]);
  const shareLink = installLinkUrl(appUrl, token);
  const snippets = buildSnippets({ appUrl, publishableKey: keys.widget_publishable_key });

  const steps: Step[] = [
    {
      id: "stripe",
      title: "Connect Stripe",
      who: "You · no code · 1 minute",
      body: "One click with Stripe Connect. Unquit reads your subscriptions and invoices, and applies the offers your customers accept.",
      done: connected,
      icon: Plug,
      links: connected ? [{ href: "/dashboard", label: "Connected" }] : [{ href: "/api/stripe/connect", label: "Connect Stripe", external: true }],
    },
    {
      id: "flow",
      title: "Pick your offers",
      who: "You · no code · 5 minutes",
      body: "Choose what a customer sees when they try to cancel: the reasons they can pick and an offer for each (a discount, a pause or a cheaper plan).",
      done: status.flowSaved,
      icon: Workflow,
      links: [{ href: "/dashboard/flows", label: status.flowSaved ? "Edit offers" : "Pick offers" }],
    },
    {
      id: "widget",
      title: "Add the cancel flow to your app",
      who: "Your developer · about 15 minutes",
      body: "A small piece of code so your Cancel button opens Unquit's offer screen. Send your developer the link below; it has everything they need.",
      done: status.widgetUsed,
      icon: Code2,
      links: [
        { href: "#share-title", label: "Send to developer" },
        { href: "/dashboard/test", label: "Test it" },
      ],
    },
    {
      id: "dunning",
      title: "Turn on failed-payment emails",
      who: "You · no code · 2 minutes",
      body: "When a card fails, Unquit emails the customer a link to fix it, matched to why the payment failed. Switch it on and check the wording.",
      done: status.dunningOn,
      icon: CreditCard,
      links: [{ href: "/dashboard/dunning", label: status.dunningOn ? "Edit emails" : "Set up emails" }],
    },
    {
      id: "billing",
      title: "Add a billing card",
      who: "You · no code · 1 minute",
      body: "Save a card once through Dodo Payments, unquit's merchant of record. Nothing is charged now; on the 1st of each month only last month's fees (capped at $299) are charged.",
      done: status.billingCard,
      icon: Wallet,
      links: [{ href: "/dashboard/billing", label: status.billingCard ? "Billing card saved" : "Add a billing card" }],
    },
  ];
  const doneCount = steps.filter((s) => s.done).length;

  return (
    <div className="space-y-8">
      <PageHeader
        title="Setup guide"
        badge={<Badge tone={doneCount === steps.length ? "success" : "neutral"} dot>{`${doneCount} of ${steps.length} done`}</Badge>}
        description="Everything Unquit needs, in plain English. Four steps are clicks in this dashboard; one is a short job for your developer."
      />

      {searchParams.link === "rotated" ? (
        <p role="status" className="flex items-center gap-2.5 rounded-xl border border-brand/30 bg-brand-soft px-4 py-3 text-sm text-foreground shadow-xs">
          <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-brand" /> New setup link made. The old one no longer works.
        </p>
      ) : searchParams.link === "rotate_failed" ? (
        <p role="status" className="flex items-center gap-2.5 rounded-xl border border-danger/30 bg-danger-soft px-4 py-3 text-sm text-danger shadow-xs">
          <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-danger" /> We couldn&apos;t make a new link. Please try again.
        </p>
      ) : null}

      <section aria-labelledby="video-title" className="overflow-hidden rounded-2xl border border-border bg-card shadow-card">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-5 py-3.5">
          <h2 id="video-title" className="text-sm font-semibold text-foreground">
            How Unquit works
          </h2>
          <span className="text-xs text-muted-foreground">90 seconds</span>
        </div>
        <video
          controls
          preload="none"
          playsInline
          poster="/media/how-unquit-works-poster.jpg"
          className="aspect-video w-full bg-zinc-950"
          aria-label="How Unquit works, a 90-second explainer video"
        >
          <source src="/media/how-unquit-works.mp4" type="video/mp4" />
          Your browser can&apos;t play this video. <a href="/media/how-unquit-works.mp4">Download it</a> instead.
        </video>
      </section>

      <section aria-labelledby="steps-title">
        <h2 id="steps-title" className="text-sm font-semibold text-foreground">
          Five steps to set up
        </h2>
        <ol className="mt-3 grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {steps.map((step, i) => (
            <StepCard key={step.id} step={step} n={i + 1} isNext={step === steps.find((s) => !s.done)} />
          ))}
        </ol>
      </section>

      <ShareCard link={shareLink} message={developerMessage(shareLink)} />

      <section id="developer" aria-labelledby="developer-title" className="scroll-mt-20 rounded-2xl border border-border bg-card p-5 shadow-card sm:p-7">
        <div className="mb-6">
          <div className="flex flex-wrap items-center gap-2.5">
            <h2 id="developer-title" className="text-lg font-semibold tracking-tight text-foreground">
              For your developer
            </h2>
            <Badge tone="info">About 15 minutes</Badge>
          </div>
          <p className="mt-1.5 max-w-2xl text-sm text-muted-foreground">
            The same instructions your setup link shows, with your publishable key filled in. Three pieces: a script tag, one server endpoint,
            and a click handler.
          </p>
        </div>
        <DeveloperGuide snippets={snippets} publishableKey={keys.widget_publishable_key} audience="founder" />
      </section>
    </div>
  );
}

function StepCard({ step, n, isNext }: { step: Step; n: number; isNext: boolean }) {
  const Icon = step.icon;
  return (
    <li
      className={cn(
        "flex flex-col rounded-xl border bg-card p-5 shadow-card",
        isNext ? "border-brand/40 ring-1 ring-brand/20" : "border-border",
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <span
          className={cn(
            "flex h-7 w-7 items-center justify-center rounded-full border text-xs font-semibold",
            step.done ? "border-brand bg-brand text-white shadow-glow-sm" : "border-border text-muted-foreground",
          )}
        >
          {step.done ? <Check className="h-3.5 w-3.5" aria-hidden="true" /> : n}
        </span>
        {step.done ? (
          <Badge tone="success" dot>
            Done
          </Badge>
        ) : isNext ? (
          <Badge tone="warning" dot="pulse">
            Next up
          </Badge>
        ) : (
          <Badge tone="neutral">Not yet</Badge>
        )}
      </div>
      <h3 className="mt-4 flex items-center gap-2 text-sm font-semibold text-foreground">
        <Icon className="h-4 w-4 shrink-0 text-brand-text" aria-hidden="true" />
        {step.title}
      </h3>
      <p className="mt-1 text-2xs font-medium uppercase tracking-wider text-muted-foreground">{step.who}</p>
      <p className="mt-2 flex-1 text-sm leading-relaxed text-muted-foreground">{step.body}</p>
      <div className="mt-4 flex flex-wrap gap-2">
        {step.links.map((link, i) => {
          const className = cn(
            "inline-flex h-8 items-center gap-1.5 rounded-lg px-3 text-xs font-medium transition-[transform,background-color] active:scale-[0.97]",
            i === 0 && !step.done ? "bg-foreground text-background hover:bg-foreground/85" : "border border-border bg-card text-foreground hover:bg-muted",
          );
          return link.external ? (
            // A plain <a>: this route redirects off-site to Stripe.
            <a key={link.href} href={link.href} className={className}>
              {link.label} <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
            </a>
          ) : (
            <Link key={link.href} href={link.href} className={className}>
              {link.label} <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
            </Link>
          );
        })}
      </div>
    </li>
  );
}
