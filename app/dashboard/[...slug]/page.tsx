import { ArrowRight } from "lucide-react";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { PageHeader } from "@/components/DashboardShell";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";

/**
 * Fallback for sidebar pages that don't exist on this branch yet. Any real
 * page (e.g. app/dashboard/billing/page.tsx) takes precedence over this
 * catch-all, so it disappears on its own as those pages land.
 */
export default function PlaceholderPage({ params }: { params: { slug: string[] } }) {
  const [first, ...rest] = params.slug;
  if (first === "saves" && rest.length === 0) redirect("/dashboard#ledger");
  if (first === "billing" && rest.length === 0) {
    return (
      <>
        <PageHeader title="Billing" description="Your monthly unquit invoice, the $299 cap and statements." />
        <Card>
          <EmptyState
            art="receipts"
            title="Billing is on its way"
            description="Monthly statements and invoices will live here. Until then, this month's fees are on the overview."
            action={
              <Button asChild variant="secondary">
                <Link href="/dashboard">
                  Go to overview <ArrowRight className="h-4 w-4" />
                </Link>
              </Button>
            }
          />
        </Card>
      </>
    );
  }
  notFound();
}
