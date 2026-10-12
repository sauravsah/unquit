"use client";

import { loadStripe, type Stripe, type StripeElements } from "@stripe/stripe-js";
import { useCallback, useEffect, useRef, useState } from "react";

type Phase =
  | { name: "loading" }
  | { name: "ready" }
  | { name: "working"; label: string }
  | { name: "success" }
  | { name: "unavailable"; message: string };

type ApiResult =
  | { status: "ready"; clientSecret: string; stripeAccount: string }
  | { status: "paid"; amountCents: number; currency: string }
  | { status: "requires_action"; clientSecret: string }
  | { status: "failed"; message: string }
  | { status: "link"; state: string };

async function post(path: string, body: Record<string, unknown> = {}): Promise<ApiResult> {
  const response = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = (await response.json().catch(() => null)) as ApiResult | null;
  if (json && "status" in json) return json;
  return { status: "failed", message: "Something went wrong. Please try again." };
}

/**
 * Collects a new card with Stripe Elements ON THE FOUNDER'S Stripe account
 * (a SetupIntent created with the Stripe-Account header), then asks the
 * server to make it the default and pay the open invoice. 3-D Secure is
 * handled twice over: when the card is saved (confirmSetup) and, if the bank
 * asks again, on the payment itself (handleNextAction).
 */
export function CardUpdateForm({
  token,
  publishableKey,
  stripeAccount,
  amountLabel,
  company,
  offerRetry,
}: {
  token: string;
  publishableKey: string;
  stripeAccount: string;
  amountLabel: string;
  company: string;
  offerRetry: boolean;
}) {
  const base = `/api/u/${encodeURIComponent(token)}`;
  const [phase, setPhase] = useState<Phase>({ name: "loading" });
  const [error, setError] = useState<string | null>(null);
  const stripeRef = useRef<Stripe | null>(null);
  const elementsRef = useRef<StripeElements | null>(null);
  const mountRef = useRef<HTMLDivElement | null>(null);
  const successRef = useRef<HTMLHeadingElement | null>(null);
  const errorRef = useRef<HTMLParagraphElement | null>(null);
  const started = useRef(false);

  const fail = useCallback((message: string) => {
    setError(message);
    setPhase({ name: "ready" });
    requestAnimationFrame(() => errorRef.current?.focus());
  }, []);

  /** Turns a server answer into the next screen. */
  const settle = useCallback(
    async (result: ApiResult): Promise<"done" | "retry_card"> => {
      if (result.status === "paid") {
        setError(null);
        setPhase({ name: "success" });
        requestAnimationFrame(() => successRef.current?.focus());
        return "done";
      }
      if (result.status === "link") {
        window.location.reload(); // the page explains (already paid, expired, …)
        return "done";
      }
      if (result.status === "requires_action") {
        const stripe = stripeRef.current;
        if (!stripe) {
          fail("Your bank needs you to confirm this payment, but the secure form didn't load. Please refresh the page.");
          return "done";
        }
        setPhase({ name: "working", label: "Waiting for your bank to confirm…" });
        const { error: actionError } = await stripe.handleNextAction({ clientSecret: result.clientSecret });
        if (actionError) {
          // Tell the server so it stops waiting for this attempt.
          await post(`${base}/confirm`);
          fail(actionError.message ?? "Your bank didn't approve the payment. Please try again or use a different card.");
          return "retry_card";
        }
        return settle(await post(`${base}/confirm`));
      }
      if (result.status === "failed") {
        fail(result.message);
        return "retry_card";
      }
      return "done";
    },
    [base, fail],
  );

  /** Creates a fresh SetupIntent and (re)mounts the card form. */
  const prepareCardForm = useCallback(async () => {
    if (!publishableKey) {
      setPhase({ name: "unavailable", message: "Card payments aren't set up yet. Please contact the company that sent you this link." });
      return;
    }
    const setup = await post(`${base}/setup`);
    if (setup.status !== "ready") {
      await settle(setup);
      return;
    }
    const stripe = stripeRef.current ?? (await loadStripe(publishableKey, { stripeAccount: setup.stripeAccount }));
    if (!stripe || !mountRef.current) {
      setPhase({ name: "unavailable", message: "The secure card form couldn't load. Please check your connection and refresh." });
      return;
    }
    stripeRef.current = stripe;
    elementsRef.current?.getElement("payment")?.destroy();
    const elements = stripe.elements({
      clientSecret: setup.clientSecret,
      appearance: {
        theme: "stripe",
        variables: {
          colorPrimary: "#16A34A",
          colorText: "#0A0A0A",
          colorDanger: "#B91C1C",
          borderRadius: "10px",
          fontSizeBase: "16px", // 16px+ stops iOS zooming into the field
        },
      },
    });
    elements.create("payment", { layout: "tabs" }).mount(mountRef.current);
    elementsRef.current = elements;
    setPhase((p) => (p.name === "working" ? p : { name: "ready" }));
  }, [base, publishableKey, settle]);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const params = new URLSearchParams(window.location.search);
    const returnedSetup = params.get("setup_intent");
    const redirectStatus = params.get("redirect_status");
    // Back from a bank page that needed a full redirect (rare for cards).
    if (returnedSetup && redirectStatus) {
      window.history.replaceState(null, "", window.location.pathname);
      void (async () => {
        await prepareCardForm();
        if (redirectStatus === "succeeded") {
          setPhase({ name: "working", label: `Paying ${amountLabel}…` });
          const outcome = await settle(await post(`${base}/pay`, { setupIntentId: returnedSetup }));
          if (outcome === "retry_card") await prepareCardForm();
        } else {
          fail("Your card wasn't confirmed. Please try again or use a different card.");
        }
      })();
      return;
    }
    void prepareCardForm().catch(() =>
      setPhase({ name: "unavailable", message: "The secure card form couldn't load. Please check your connection and refresh." }),
    );
  }, [amountLabel, base, fail, prepareCardForm, settle]);

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    const stripe = stripeRef.current;
    const elements = elementsRef.current;
    if (!stripe || !elements || phase.name !== "ready") return;
    setError(null);
    setPhase({ name: "working", label: "Checking your card…" });

    const { error: setupError, setupIntent } = await stripe.confirmSetup({
      elements,
      redirect: "if_required",
      confirmParams: { return_url: window.location.href.split("?")[0]! },
    });
    if (setupError) {
      fail(setupError.message ?? "Your card couldn't be saved. Please check the details and try again.");
      return;
    }
    if (!setupIntent || setupIntent.status !== "succeeded") {
      fail("Your card wasn't confirmed. Please try again or use a different card.");
      return;
    }

    setPhase({ name: "working", label: `Paying ${amountLabel}…` });
    const outcome = await settle(await post(`${base}/pay`, { setupIntentId: setupIntent.id }));
    // A declined card can't be reused with the same SetupIntent: start a fresh form.
    if (outcome === "retry_card") await prepareCardForm();
  }

  async function onRetry() {
    if (phase.name !== "ready") return;
    setError(null);
    setPhase({ name: "working", label: `Trying your current card for ${amountLabel}…` });
    await settle(await post(`${base}/retry`));
  }

  if (phase.name === "success") {
    return (
      <div role="status" className="mt-6 animate-slide-up rounded-2xl border border-brand/30 bg-brand-soft p-5 text-center">
        <span aria-hidden="true" className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-brand text-white shadow-glow">
          <svg viewBox="0 0 24 24" className="h-6 w-6" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="m5 12.5 4.5 4.5L19 7.5" />
          </svg>
        </span>
        <h2 ref={successRef} tabIndex={-1} className="mt-4 text-xl font-semibold text-foreground focus:outline-none">
          Payment received. Thank you!
        </h2>
        <p className="mt-2 text-[15px] leading-relaxed text-muted-foreground">
          {amountLabel} has been paid to {company}, and your card is saved for future renewals. You can close this page.
        </p>
      </div>
    );
  }

  if (phase.name === "unavailable") {
    return (
      <p role="alert" className="mt-6 rounded-2xl border border-danger/30 bg-danger-soft p-4 text-[15px] text-danger">
        {phase.message}
      </p>
    );
  }

  const busy = phase.name === "working" || phase.name === "loading";

  return (
    <form onSubmit={onSubmit} className="mt-6" aria-busy={busy} noValidate>
      <fieldset disabled={phase.name === "working"} className="min-w-0">
        <legend className="mb-3 flex w-full items-center justify-between text-sm font-semibold text-foreground">
          New card
          <span className="flex items-center gap-1 text-2xs font-medium text-muted-foreground" aria-hidden="true">
            <span className="rounded border border-border bg-surface px-1.5 py-0.5">VISA</span>
            <span className="rounded border border-border bg-surface px-1.5 py-0.5">MC</span>
            <span className="rounded border border-border bg-surface px-1.5 py-0.5">AMEX</span>
          </span>
        </legend>
        <div className="relative min-h-[120px]">
          {phase.name === "loading" ? (
            <div aria-hidden="true" className="absolute inset-0 space-y-3">
              <div className="h-11 animate-pulse rounded-lg bg-muted" />
              <div className="grid grid-cols-2 gap-3">
                <div className="h-11 animate-pulse rounded-lg bg-muted" />
                <div className="h-11 animate-pulse rounded-lg bg-muted" />
              </div>
            </div>
          ) : null}
          <div ref={mountRef} className="min-h-[120px]" />
        </div>
        {phase.name === "loading" ? <p className="mt-2 text-sm text-muted-foreground">Loading the secure card form…</p> : null}
      </fieldset>

      {error ? (
        <p
          ref={errorRef}
          tabIndex={-1}
          role="alert"
          className="mt-4 animate-slide-up rounded-xl border border-danger/30 bg-danger-soft px-4 py-3 text-sm text-danger focus:outline-none"
        >
          {error}
        </p>
      ) : null}

      <p aria-live="polite" className="sr-only">
        {phase.name === "working" ? phase.label : ""}
      </p>

      <button
        type="submit"
        disabled={busy}
        className="group relative mt-6 inline-flex min-h-[52px] w-full items-center justify-center gap-2 overflow-hidden rounded-xl bg-gradient-to-b from-brand-dark to-[#166534] px-5 py-3 text-base font-semibold text-white shadow-glow-sm transition-[box-shadow,transform,filter] hover:shadow-glow hover:brightness-110 active:scale-[0.98] focus:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60"
      >
        {phase.name === "working" ? (
          <svg aria-hidden="true" viewBox="0 0 24 24" className="h-5 w-5 animate-spin" fill="none">
            <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity=".3" strokeWidth="3" />
            <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
          </svg>
        ) : (
          <svg aria-hidden="true" viewBox="0 0 20 20" className="h-4 w-4 fill-current opacity-90">
            <path d="M10 1a5 5 0 0 0-5 5v2H4a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-7a2 2 0 0 0-2-2h-1V6a5 5 0 0 0-5-5Zm-3 7V6a3 3 0 1 1 6 0v2H7Z" />
          </svg>
        )}
        {phase.name === "working" ? phase.label : `Save card and pay ${amountLabel}`}
      </button>

      {offerRetry ? (
        <div className="mt-6 border-t border-border pt-5 text-center">
          <p className="text-sm text-muted-foreground">Sorted things out with your bank?</p>
          <button
            type="button"
            onClick={onRetry}
            disabled={busy}
            className="mt-2 inline-flex min-h-[44px] items-center justify-center rounded-lg px-4 py-2 text-sm font-semibold text-brand-text underline underline-offset-2 hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-brand disabled:opacity-60"
          >
            Try my current card again
          </button>
        </div>
      ) : null}
    </form>
  );
}
