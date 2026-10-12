import Link from "next/link";
import { Wordmark } from "@/components/Wordmark";

const steps = [
  {
    title: "Connect Stripe",
    body: "One click with Stripe Connect. No code changes to your billing.",
  },
  {
    title: "We catch the leaving",
    body: "A cancel flow with the right offer, a pause, or a short exit survey. Smart retries and a card-update link for failed payments.",
  },
  {
    title: "You pay for proof",
    body: "A save counts only when the customer's next invoice is paid. Every save gets a receipt you can dispute.",
  },
];

const pricing = [
  { value: "$0", label: "base fee" },
  { value: "20%", label: "of saved MRR, first 3 months only" },
  { value: "10%", label: "of recovered failed payments" },
  { value: "$299", label: "monthly cap, ever" },
];

export default function LandingPage() {
  return (
    <div className="min-h-screen bg-white">
      <header className="mx-auto flex max-w-5xl items-center justify-between px-6 py-6">
        <Wordmark />
        <Link href="/login" className="text-sm font-medium text-neutral-700 hover:text-ink">
          Sign in
        </Link>
      </header>

      <main className="mx-auto max-w-5xl px-6">
        <section className="py-20 sm:py-28">
          <p className="text-sm font-medium text-brand">Churn recovery for Stripe</p>
          <h1 className="mt-4 max-w-3xl text-4xl font-semibold leading-tight tracking-tight text-ink sm:text-6xl">
            Unquit your customers. Pay only for the ones we keep.
          </h1>
          <p className="mt-6 max-w-2xl text-lg text-neutral-600">
            Cancel-flow offers, pauses and failed-payment recovery for subscription businesses on Stripe. No base fee,
            no annual contract. If we don&apos;t save revenue, you don&apos;t pay.
          </p>
          <div className="mt-10 flex flex-wrap items-center gap-4">
            <Link
              href="/login"
              className="rounded-lg bg-brand px-5 py-3 text-sm font-semibold text-white shadow-sm hover:bg-brand-dark focus:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2"
            >
              Get started free
            </Link>
            <span className="text-sm text-neutral-500">Sign in with a magic link. No card needed.</span>
          </div>
        </section>

        <section className="grid gap-6 border-t border-neutral-200 py-16 sm:grid-cols-3">
          {steps.map((step, i) => (
            <div key={step.title}>
              <p className="text-sm font-medium text-neutral-400">0{i + 1}</p>
              <h2 className="mt-2 text-lg font-semibold text-ink">{step.title}</h2>
              <p className="mt-2 text-sm leading-relaxed text-neutral-600">{step.body}</p>
            </div>
          ))}
        </section>

        <section className="border-t border-neutral-200 py-16">
          <h2 className="text-2xl font-semibold tracking-tight text-ink">Pricing that only moves when you win</h2>
          <dl className="mt-8 grid gap-6 sm:grid-cols-4">
            {pricing.map((item) => (
              <div key={item.label} className="rounded-xl border border-neutral-200 p-5">
                <dt className="text-3xl font-semibold text-ink">{item.value}</dt>
                <dd className="mt-1 text-sm text-neutral-600">{item.label}</dd>
              </div>
            ))}
          </dl>
          <p className="mt-6 max-w-2xl text-sm text-neutral-500">
            A cancel save counts only when the customer accepted an offer and their next invoice was paid. If they are
            refunded inside the dispute window, the fee comes back to you automatically.
          </p>
        </section>
      </main>

      <footer className="mx-auto max-w-5xl border-t border-neutral-200 px-6 py-8 text-sm text-neutral-500">
        © {new Date().getFullYear()} unquit
      </footer>
    </div>
  );
}
