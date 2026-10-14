import type { Metadata } from "next";
import { loadUpdatePage, type PageView } from "@/lib/dunning/card-update";
import { cardUpdateDeps, companyResolver } from "@/lib/dunning/runtime";
import { publicEnv } from "@/lib/env";
import { formatCents } from "@/lib/pricing";
import { CardUpdateForm } from "./CardUpdateForm";
import { getDb } from "@/lib/db";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Update your payment details",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

const MESSAGES: Record<"invalid" | "expired" | "used" | "closed" | "error", { title: string; body: string }> = {
  invalid: {
    title: "This link doesn't work",
    body: "Please use the button in the most recent email you received about your payment.",
  },
  expired: {
    title: "This link has expired",
    body: "For your security, payment links only work for a limited time. Please use the button in the most recent email about your payment.",
  },
  used: {
    title: "Your payment is already sorted",
    body: "This link has already been used to pay. There's nothing more to do.",
  },
  closed: {
    title: "Nothing to pay here",
    body: "This invoice is no longer open, so there's nothing to pay. If you think that's wrong, reply to the email you received.",
  },
  error: {
    title: "We couldn't load this page",
    body: "Something went wrong on our side. Please try again in a few minutes.",
  },
};

export default async function UpdateCardPage({ params }: { params: { token: string } }) {
  let view: PageView | { state: "error"; company: null };
  try {
    const db = getDb();
    view = await loadUpdatePage(cardUpdateDeps(db), params.token, companyResolver(db));
  } catch (error) {
    console.error("[u] loading card-update page failed", error);
    view = { state: "error", company: null };
  }

  const initial = (view.company ?? "P").trim().charAt(0).toUpperCase() || "P";

  return (
    // Always the light palette: a payment page should look the same for everyone.
    <div className="light min-h-screen bg-surface text-foreground [color-scheme:light]">
      <div aria-hidden="true" className="pointer-events-none fixed inset-x-0 top-0 h-72 bg-gradient-to-b from-brand/[0.07] to-transparent" />
      <main className="relative mx-auto flex min-h-screen w-full max-w-md flex-col px-4 pb-8 pt-6 sm:px-5 sm:pt-14">
        <header className="mb-6 flex items-center gap-3">
          <span
            aria-hidden="true"
            className="flex h-10 w-10 items-center justify-center rounded-xl bg-foreground text-base font-semibold text-background shadow-lift"
          >
            {initial}
          </span>
          <div className="min-w-0">
            <p className="truncate text-base font-semibold tracking-tight text-foreground">{view.company ?? "Payment"}</p>
            <p className="flex items-center gap-1 text-xs text-muted-foreground">
              <LockIcon className="h-3 w-3" /> Secure payment page
            </p>
          </div>
        </header>

        <div className="flex-1 animate-slide-up rounded-3xl border border-border bg-card p-5 shadow-float sm:p-7">
          {view.state === "ok" || view.state === "paid" ? (
            <section aria-labelledby="page-title">
              {view.state === "paid" ? (
                <PaidNotice amount={formatCents(view.amountCents, view.currency)} company={view.company} />
              ) : (
                <>
                  <h1 id="page-title" className="text-xl font-semibold tracking-tight text-foreground sm:text-2xl">
                    Update your card
                  </h1>
                  <p className="mt-1.5 text-[15px] leading-relaxed text-muted-foreground">
                    Your last payment to {view.company} didn&apos;t go through. Add a card below and we&apos;ll pay the invoice straight
                    away.
                  </p>

                  <dl className="mt-5 overflow-hidden rounded-2xl border border-border bg-surface">
                    <div className="flex items-center justify-between gap-4 px-4 py-3.5">
                      <dt className="text-sm text-muted-foreground">Amount due</dt>
                      <dd className="text-2xl font-semibold tabular-nums tracking-tight text-foreground">
                        {formatCents(view.amountCents, view.currency)}
                      </dd>
                    </div>
                    <div className="flex items-center justify-between gap-4 border-t border-border px-4 py-3">
                      <dt className="text-sm text-muted-foreground">Invoice</dt>
                      <dd className="text-sm text-foreground">
                        {view.hostedInvoiceUrl ? (
                          <a
                            href={view.hostedInvoiceUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="font-medium text-brand-text underline underline-offset-2 hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-brand"
                          >
                            {view.invoiceNumber ?? "View invoice"}
                            <span className="sr-only"> (opens in a new tab)</span>
                          </a>
                        ) : (
                          (view.invoiceNumber ?? "—")
                        )}
                      </dd>
                    </div>
                  </dl>

                  <CardUpdateForm
                    token={params.token}
                    publishableKey={view.publishableKey ?? safePublishableKey()}
                    stripeAccount={view.stripeAccount}
                    amountLabel={formatCents(view.amountCents, view.currency)}
                    company={view.company}
                    offerRetry
                  />
                </>
              )}
            </section>
          ) : (
            <section aria-labelledby="page-title" className="py-4 text-center">
              <span aria-hidden="true" className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl border border-border bg-surface">
                <LockIcon className="h-5 w-5 text-muted-foreground" />
              </span>
              <h1 id="page-title" className="mt-4 text-xl font-semibold tracking-tight text-foreground">
                {MESSAGES[view.state].title}
              </h1>
              <p className="mt-2 text-[15px] leading-relaxed text-muted-foreground">{MESSAGES[view.state].body}</p>
            </section>
          )}
        </div>

        <footer className="mt-6 space-y-3 text-center text-xs text-muted-foreground">
          <div className="flex items-center justify-center gap-4">
            <span className="inline-flex items-center gap-1.5">
              <LockIcon className="h-3.5 w-3.5 text-brand-text" /> Encrypted connection
            </span>
            <span className="inline-flex items-center gap-1.5">
              <svg aria-hidden="true" viewBox="0 0 20 20" className="h-3.5 w-3.5 fill-current text-brand-text">
                <path d="M10 1 3 4v5c0 4.4 3 8.5 7 10 4-1.5 7-5.6 7-10V4l-7-3Zm-1 13-4-4 1.4-1.4L9 11.2l4.6-4.6L15 8l-6 6Z" />
              </svg>
              3-D Secure ready
            </span>
          </div>
          <p>
            Card details go straight to Stripe and are never stored by us. Powered by{" "}
            <span className="font-semibold text-foreground">
              unquit<span className="text-brand">.</span>
            </span>
          </p>
        </footer>
      </main>
    </div>
  );
}

function LockIcon({ className }: { className?: string }) {
  return (
    <svg aria-hidden="true" viewBox="0 0 20 20" className={`fill-current ${className ?? ""}`}>
      <path d="M10 1a5 5 0 0 0-5 5v2H4a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-7a2 2 0 0 0-2-2h-1V6a5 5 0 0 0-5-5Zm-3 7V6a3 3 0 1 1 6 0v2H7Z" />
    </svg>
  );
}

function safePublishableKey(): string {
  try {
    return publicEnv.stripePublishableKey();
  } catch {
    return "";
  }
}

function PaidNotice({ amount, company }: { amount: string; company: string }) {
  return (
    <div role="status" className="py-4 text-center">
      <span aria-hidden="true" className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-brand text-white shadow-glow">
        <svg viewBox="0 0 24 24" className="h-7 w-7" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="m5 12.5 4.5 4.5L19 7.5" />
        </svg>
      </span>
      <h1 id="page-title" className="mt-5 text-2xl font-semibold tracking-tight text-foreground">
        You&apos;re all set
      </h1>
      <p className="mt-2 text-[15px] leading-relaxed text-muted-foreground">
        Your payment of {amount} to {company} has gone through. Thank you! You can close this page.
      </p>
    </div>
  );
}
