import { redirect } from "next/navigation";
import { CircleAlert, CircleGauge, Coins, RotateCcw } from "lucide-react";
import { ConnectFirst, DashboardShell, PageHeader } from "@/components/DashboardShell";
import { DunningCasesTable } from "@/components/dashboard/DunningCasesTable";
import { Stagger, StaggerItem } from "@/components/motion";
import { Badge } from "@/components/ui/badge";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ProgressRing } from "@/components/ui/progress-ring";
import { StatCard } from "@/components/ui/stat-card";
import { getOrCreateAccount } from "@/lib/accounts";
import { loadDunningDashboard } from "@/lib/dunning/dashboard";
import { MONTHLY_FEE_CAP_CENTS, formatCents } from "@/lib/pricing";
import { DunningEditor } from "./DunningEditor";
import { getSessionUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db";

export const dynamic = "force-dynamic";

export default async function DunningPage() {
  const db = getDb();
  const user = await getSessionUser();
  if (!user) redirect("/login?next=/dashboard/dunning");

  const account = await getOrCreateAccount(db, user);
  const connected = account.stripe_connection_status === "connected" && !!account.stripe_account_id;
  if (!connected) {
    return (
      <DashboardShell email={user.email} active="/dashboard/dunning" showTabs={false}>
        <ConnectFirst />
      </DashboardShell>
    );
  }

  const data = await loadDunningDashboard(db, account.id);
  const defaultCompany = account.name && !account.name.includes("@") ? account.name : "";

  return (
    <DashboardShell email={user.email} active="/dashboard/dunning">
      <div className="space-y-6">
        <PageHeader
          title="Failed payments"
          className="mb-2"
          badge={data.settings.enabled ? <Badge tone="success" dot="pulse">Emails on</Badge> : <Badge dot>Emails off</Badge>}
          description={
            <>
              When a renewal fails, unquit emails the customer a link to update their card and pays the invoice straight away. You pay
              10% of what comes back through unquit&apos;s link or retry. Payments Stripe recovers on its own are free.
            </>
          }
        />

        <Stagger className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <StaggerItem>
            <StatCard label="Open cases" icon={<CircleAlert />} value={data.openCount} format="integer" hint={`${formatCents(data.openAmountCents)} waiting to be paid`} />
          </StaggerItem>
          <StaggerItem>
            <StatCard label="Recovered by unquit · this month" icon={<RotateCcw />} value={data.recoveredByUnquitThisMonthCents} format="cents" emphasis />
          </StaggerItem>
          <StaggerItem>
            <StatCard
              label="Recovered in total · this month"
              icon={<Coins />}
              value={data.recoveredThisMonthCents}
              format="cents"
              hint="Includes Stripe's own retries (no fee)"
            />
          </StaggerItem>
          <StaggerItem>
            <StatCard
              label="Dunning fees · this month"
              icon={<CircleGauge />}
              value={data.dunningFeesThisMonthCents}
              format="cents"
              hint={`You pay ${formatCents(data.bill.totalCents)} so far`}
              aside={<ProgressRing value={data.bill.totalCents / MONTHLY_FEE_CAP_CENTS} label={`Fees used of the ${formatCents(MONTHLY_FEE_CAP_CENTS)} cap`} />}
            />
          </StaggerItem>
        </Stagger>

        <Card className="overflow-hidden">
          <CardHeader>
            <div>
              <CardTitle>Cases</CardTitle>
              <CardDescription>The 50 most recent failed invoices</CardDescription>
            </div>
          </CardHeader>
          <DunningCasesTable rows={data.cases} />
        </Card>

        <DunningEditor initial={data.settings} saved={data.hasSettingsRow} defaultCompany={defaultCompany} />
      </div>
    </DashboardShell>
  );
}
