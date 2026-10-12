import { notFound, redirect } from "next/navigation";

/**
 * /dashboard/saves (the sidebar's "Saves & ledger") has no index page: the
 * ledger lives on the overview, receipts at /dashboard/saves/<receipt>.
 * Real pages always take precedence over this catch-all.
 */
export default function PlaceholderPage({ params }: { params: { slug: string[] } }) {
  const [first, ...rest] = params.slug;
  if (first === "saves" && rest.length === 0) redirect("/dashboard#ledger");
  notFound();
}
