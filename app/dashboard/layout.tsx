import { cookies } from "next/headers";
import { AppShell } from "@/components/app-shell/AppShell";
import { SIDEBAR_COOKIE } from "@/components/app-shell/nav";
import { createSupabaseServerClient } from "@/lib/supabase/server";

/**
 * The frame around every /dashboard page. Pages still do their own auth
 * redirect and data loading; this only reads what the shell shows.
 */
export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  let email: string | undefined;
  let livemode: boolean | null = null;
  let connected = false;
  try {
    const supabase = createSupabaseServerClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (user) {
      email = user.email;
      const { data } = await supabase
        .from("accounts")
        .select("stripe_account_id, stripe_connection_status, stripe_livemode")
        .eq("owner_user_id", user.id)
        .maybeSingle();
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
