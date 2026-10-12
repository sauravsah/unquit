import { redirect } from "next/navigation";
import { ConnectFirst, DashboardShell, PageHeader } from "@/components/DashboardShell";
import { getOrCreateAccount } from "@/lib/accounts";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { WidgetTester } from "./WidgetTester";

export const dynamic = "force-dynamic";

export default async function TestWidgetPage() {
  const supabase = createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login?next=/dashboard/test");

  const account = await getOrCreateAccount(supabase, user);
  const connected = account.stripe_connection_status === "connected" && !!account.stripe_account_id;

  return (
    <DashboardShell email={user.email} active="/dashboard/test" showTabs={connected}>
      {connected ? (
        <>
          <PageHeader
            title="Test the widget"
            description={
              <>
                Opens the real widget against the real API, exactly as your customers will see it. Use a{" "}
                <strong className="font-medium text-foreground">test-mode</strong> customer: accepting an offer really applies it in
                Stripe, and cancelling really cancels.
              </>
            }
          />
          <WidgetTester livemode={account.stripe_livemode} />
        </>
      ) : (
        <ConnectFirst />
      )}
    </DashboardShell>
  );
}
