import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Logo } from "@/components/Logo";
import { DeveloperGuide } from "@/components/install/DeveloperGuide";
import { getDb } from "@/lib/db";
import { publicEnv } from "@/lib/env";
import { loadPublicInstallView } from "@/lib/install/repo";
import { buildSnippets } from "@/lib/install/snippets";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Add the Unquit cancel flow · developer setup",
  robots: { index: false, follow: false, nocache: true, googleBot: { index: false, follow: false } },
  referrer: "no-referrer",
};

/**
 * Public developer setup page, reached through a founder's share link. No
 * login. Shows ONLY the instructions and the founder's publishable key (public
 * by design): never the signing secret, the account or any dashboard data.
 * An unknown, tampered or rotated token is a 404.
 */
export default async function PublicInstallPage({ params }: { params: { token: string } }) {
  const view = await loadPublicInstallView(getDb(), params.token);
  if (!view) notFound();

  const snippets = buildSnippets({ appUrl: publicEnv.appUrl(), publishableKey: view.publishableKey });

  return (
    <div className="min-h-screen bg-surface text-foreground">
      <div aria-hidden="true" className="pointer-events-none fixed inset-x-0 top-0 h-72 bg-gradient-to-b from-brand/[0.07] to-transparent" />
      <main className="relative mx-auto w-full max-w-4xl px-4 pb-16 pt-8 sm:px-6 sm:pt-14">
        <header className="mb-10">
          <Logo href={null} />
          <h1 className="mt-8 text-3xl font-semibold tracking-tight text-foreground">Add the cancel flow</h1>
          <p className="mt-3 max-w-2xl text-sm leading-relaxed text-muted-foreground">
            You were sent this link to add Unquit to an app. When a customer clicks Cancel, Unquit shows a short exit survey and, where it
            fits, an offer (a discount, a pause or a cheaper plan) and applies the result directly in Stripe. About 15 minutes of work: one
            script tag, one server endpoint and a click handler. The key below is already filled in.
          </p>
        </header>
        <DeveloperGuide snippets={snippets} publishableKey={view.publishableKey} audience="developer" />
        <footer className="mt-14 border-t border-border pt-6 text-xs text-muted-foreground">
          This page is private to whoever has the link. It contains no secrets: the signing secret is shared with you separately.
        </footer>
      </main>
    </div>
  );
}
