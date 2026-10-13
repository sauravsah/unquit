import { redirect } from "next/navigation";
import { ConnectFirst, DashboardShell, PageHeader } from "@/components/DashboardShell";
import { getOrCreateAccount } from "@/lib/accounts";
import type { PriceSnapshot } from "@/lib/flows/offers";
import { loadFlowRow } from "@/lib/flows/repo";
import { flowFromRow } from "@/lib/flows/schema";
import { getStripe } from "@/lib/stripe/client";
import { toPriceSnapshot } from "@/lib/widget/stripe-ops";
import { FlowEditor } from "./FlowEditor";
import { getSessionUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db";

export const dynamic = "force-dynamic";

/** The founder's recurring prices, for the downgrade picker. Empty if Stripe is unreachable. */
async function loadPrices(stripeAccount: string): Promise<PriceSnapshot[]> {
  try {
    const list = await getStripe().prices.list(
      { active: true, type: "recurring", limit: 100, expand: ["data.product"] },
      { stripeAccount },
    );
    return list.data.map(toPriceSnapshot).filter((p) => p.unitAmountCents !== null);
  } catch (error) {
    console.warn("[flows] could not list prices", error);
    return [];
  }
}

export default async function FlowsPage() {
  const db = getDb();
  const user = await getSessionUser();
  if (!user) redirect("/login?next=/dashboard/flows");

  const account = await getOrCreateAccount(db, user);
  const connected = account.stripe_connection_status === "connected" && !!account.stripe_account_id;
  if (!connected) {
    return (
      <DashboardShell email={user.email} active="/dashboard/flows" showTabs={false}>
        <ConnectFirst />
      </DashboardShell>
    );
  }

  const [row, prices] = await Promise.all([loadFlowRow(db, account.id), loadPrices(account.stripe_account_id!)]);

  return (
    <DashboardShell email={user.email} active="/dashboard/flows">
      <PageHeader
        title="Cancel flow"
        description="Choose the reasons customers can pick and the offer each one gets. The preview runs the exact code your customers see."
      />
      <FlowEditor initialFlow={flowFromRow(row)} saved={!!row} prices={prices} />
    </DashboardShell>
  );
}
