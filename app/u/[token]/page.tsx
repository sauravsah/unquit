import type { Metadata } from "next";
import { loadUpdatePage, type PageView } from "@/lib/dunning/card-update";
import { cardUpdateDeps, companyResolver } from "@/lib/dunning/runtime";
import { publicEnv } from "@/lib/env";
import { formatCents } from "@/lib/pricing";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { CardUpdateForm } from "./CardUpdateForm";

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
    const admin = createSupabaseAdminClient();
    view = await loadUpdatePage(cardUpdateDeps(admin), params.token, companyResolver(admin));
  } catch (error) {
    console.error("[u] loading card-update page failed", error);
    view = { state: "error", company: null };
  }

  return (
    <div className="min-h-screen bg-white">
      <main className="mx-auto flex min-h-screen w-full max-w-md flex-col px-5 py-8 sm:py-14">
        <header className="mb-8">
          <p className="text-lg font-semibold tracking-tight text-ink">{view.company ?? "Payment"}</p>
        </header>

        {view.state === "ok" || view.state === "paid" ? (
          <section aria-labelledby="page-title" className="flex-1">
            {view.state === "paid" ? (
              <PaidNotice amount={formatCents(view.amountCents, view.currency)} company={view.company} />
            ) : (
              <>
                <h1 id="page-title" className="text-2xl font-semibold tracking-tight text-ink">
                  Update your card
                </h1>
                <p className="mt-2 text-base leading-relaxed text-neutral-600">
                  Your last payment to {view.company} didn&apos;t go through. Add a card below and we&apos;ll pay the invoice straight
                  away.
                </p>

                <dl className="mt-6 divide-y divide-neutral-200 rounded-xl border border-neutral-200">
                  <div className="flex items-center justify-between gap-4 px-4 py-3">
                    <dt className="text-sm text-neutral-600">Amount due</dt>
                    <dd className="text-lg font-semibold tabular-nums text-ink">{formatCents(view.amountCents, view.currency)}</dd>
                  </div>
                  <div className="flex items-center justify-between gap-4 px-4 py-3">
                    <dt className="text-sm text-neutral-600">Invoice</dt>
                    <dd className="text-sm text-ink">
                      {view.hostedInvoiceUrl ? (
                        <a
                          href={view.hostedInvoiceUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="font-medium text-brand-dark underline underline-offset-2 hover:text-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-brand"
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
                  publishableKey={safePublishableKey()}
                  stripeAccount={view.stripeAccount}
                  amountLabel={formatCents(view.amountCents, view.currency)}
                  company={view.company}
                  offerRetry
                />
              </>
            )}
          </section>
        ) : (
          <section aria-labelledby="page-title" className="flex-1">
            <h1 id="page-title" className="text-2xl font-semibold tracking-tight text-ink">
              {MESSAGES[view.state].title}
            </h1>
            <p className="mt-3 text-base leading-relaxed text-neutral-600">{MESSAGES[view.state].body}</p>
          </section>
        )}

        <footer className="mt-12 flex items-center gap-2 text-xs text-neutral-500">
          <svg aria-hidden="true" viewBox="0 0 20 20" className="h-4 w-4 fill-current">
            <path d="M10 1a5 5 0 0 0-5 5v2H4a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-7a2 2 0 0 0-2-2h-1V6a5 5 0 0 0-5-5Zm-3 7V6a3 3 0 1 1 6 0v2H7Z" />
          </svg>
          <span>
            Card details go straight to Stripe and are never stored by us. Powered by{" "}
            <span className="font-semibold text-ink">
              unquit<span className="text-brand">.</span>
            </span>
          </span>
        </footer>
      </main>
    </div>
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
    <div role="status" className="rounded-xl border border-brand/30 bg-brand-light p-5">
      <h1 id="page-title" className="text-2xl font-semibold tracking-tight text-ink">
        You&apos;re all set
      </h1>
      <p className="mt-2 text-base leading-relaxed text-neutral-700">
        Your payment of {amount} to {company} has gone through. Thank you! You can close this page.
      </p>
    </div>
  );
}
