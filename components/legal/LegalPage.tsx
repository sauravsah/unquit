import Link from "next/link";
import { Logo } from "@/components/Logo";
import { Footer } from "@/components/marketing/CtaFooter";
import { ThemeToggle } from "@/components/theme/ThemeToggle";
import { cn } from "@/components/ui/cn";

export const LEGAL_LAST_UPDATED = "October 14, 2026";
export const LEGAL_CONTACT_EMAIL = "sauravsahbrj@gmail.com";
export const LEGAL_OPERATOR = "Saurav Kumar Sah, operating Unquit, based in Bengaluru, India";

const LEGAL_LINKS = [
  { href: "/terms", label: "Terms" },
  { href: "/privacy", label: "Privacy" },
  { href: "/data-use", label: "Data use" },
];

/** The frame shared by /terms, /privacy and /data-use: plain, readable, one column. */
export function LegalPage({ title, intro, current, children }: { title: string; intro: string; current: string; children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-background">
      <header className="border-b border-border">
        <div className="container flex h-16 items-center justify-between gap-4">
          <Logo />
          <nav aria-label="Legal" className="flex items-center gap-1 text-sm">
            {LEGAL_LINKS.map((l) => (
              <Link
                key={l.href}
                href={l.href}
                aria-current={l.href === current ? "page" : undefined}
                className={cn(
                  "rounded-lg px-2.5 py-1.5 transition-colors hover:bg-muted hover:text-foreground",
                  l.href === current ? "font-medium text-foreground" : "text-muted-foreground",
                )}
              >
                {l.label}
              </Link>
            ))}
            <ThemeToggle className="ml-1 hidden sm:inline-flex" />
          </nav>
        </div>
      </header>
      <main className="container max-w-3xl py-12 sm:py-16">
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Last updated: {LEGAL_LAST_UPDATED}</p>
        <h1 className="mt-3 text-4xl font-semibold tracking-tight text-foreground">{title}</h1>
        <p className="mt-4 text-lg text-muted-foreground">{intro}</p>
        <p role="note" className="mt-6 rounded-xl border border-warning/30 bg-warning-soft px-4 py-3 text-sm text-foreground">
          This is an early-stage draft written in plain English. It has not been reviewed by a lawyer and is not legal advice. If anything
          here is unclear, email <a href={`mailto:${LEGAL_CONTACT_EMAIL}`} className="font-medium underline underline-offset-4">{LEGAL_CONTACT_EMAIL}</a>.
        </p>
        <div className="mt-10 space-y-10">{children}</div>
      </main>
      <Footer />
    </div>
  );
}

export function Section({ id, title, children }: { id?: string; title: string; children: React.ReactNode }) {
  return (
    <section id={id} className="scroll-mt-20">
      <h2 className="text-xl font-semibold tracking-tight text-foreground">{title}</h2>
      <div className="mt-3 space-y-3 text-base leading-relaxed text-muted-foreground [&_strong]:font-medium [&_strong]:text-foreground">
        {children}
      </div>
    </section>
  );
}

export function List({ children }: { children: React.ReactNode }) {
  return <ul className="list-disc space-y-1.5 pl-5 marker:text-subtle">{children}</ul>;
}

export function Mail() {
  return (
    <a href={`mailto:${LEGAL_CONTACT_EMAIL}`} className="font-medium text-brand-text underline-offset-4 hover:underline">
      {LEGAL_CONTACT_EMAIL}
    </a>
  );
}
