import { cookies } from "next/headers";
import { AppShell } from "@/components/app-shell/AppShell";
import { SIDEBAR_COOKIE } from "@/components/app-shell/nav";
import { getSessionUser } from "@/lib/auth/session";
import { findAccountForUser } from "@/lib/accounts";
import { getDb } from "@/lib/db";

/**
 * The frame around every /dashboard page. Pages still do their own auth
 * redirect and data loading; this only reads what the shell shows.
 */
export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  let email: string | undefined;
  let livemode: boolean | null = null;
  let connected = false;
  try {
    const db = getDb();
    const user = await getSessionUser();
    if (user) {
      email = user.email;
      const data = await findAccountForUser(db, user.id);
      if (data) {
        connected = data.stripe_connection_status === "connected" && !!data.stripe_account_id;
        livemode = data.stripe_livemode;
      }
    }
  } catch {
    // Not configured or signed out: the page itself redirects or explains.
  }
  const collapsed = cookies().get(SIDEBAR_COOKIE)?.value === "collapsed";

  return (
    <AppShell email={email} livemode={livemode} connected={connected} initialCollapsed={collapsed}>
      {children}
    </AppShell>
  );
}
