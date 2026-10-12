import Link from "next/link";
import { Wordmark } from "@/components/Wordmark";

const TABS = [
  { href: "/dashboard", label: "Overview" },
  { href: "/dashboard/flows", label: "Cancel flow" },
  { href: "/dashboard/test", label: "Test the widget" },
] as const;

/** Header + tab bar shared by every /dashboard page. */
export function DashboardShell({
  email,
  active,
  showTabs = true,
  children,
}: {
  email: string | undefined;
  active: (typeof TABS)[number]["href"];
  showTabs?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="min-h-screen bg-neutral-50">
      <header className="border-b border-neutral-200 bg-white">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
          <Wordmark href="/dashboard" />
          <div className="flex items-center gap-4 text-sm">
            <span className="hidden text-neutral-500 sm:inline">{email}</span>
            <form action="/auth/signout" method="post">
              <button className="font-medium text-neutral-700 hover:text-ink">Sign out</button>
            </form>
          </div>
        </div>
        {showTabs ? (
          <nav aria-label="Dashboard" className="mx-auto flex max-w-6xl gap-6 overflow-x-auto px-6 text-sm">
            {TABS.map((tab) => (
              <Link
                key={tab.href}
                href={tab.href}
                aria-current={tab.href === active ? "page" : undefined}
                className={`whitespace-nowrap border-b-2 pb-3 font-medium ${
                  tab.href === active ? "border-brand text-ink" : "border-transparent text-neutral-500 hover:text-ink"
                }`}
              >
                {tab.label}
              </Link>
            ))}
          </nav>
        ) : null}
      </header>
      <main className="mx-auto max-w-6xl px-6 py-10">{children}</main>
    </div>
  );
}

/** Shown on sub-pages until Stripe is connected. */
export function ConnectFirst() {
  return (
    <section className="mx-auto max-w-xl rounded-2xl border border-neutral-200 bg-white p-10 text-center">
      <h1 className="text-2xl font-semibold tracking-tight text-ink">Connect Stripe first</h1>
      <p className="mt-3 text-sm text-neutral-600">The cancel flow works on your Stripe subscriptions, so connect your account first.</p>
      <Link
        href="/dashboard"
        className="mt-8 inline-flex items-center rounded-lg bg-brand px-5 py-3 text-sm font-semibold text-white hover:bg-brand-dark"
      >
        Go to overview
      </Link>
    </section>
  );
}
