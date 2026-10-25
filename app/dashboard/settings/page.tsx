import { ArrowRight, Keyboard, LogOut } from "lucide-react";
import { redirect } from "next/navigation";
import { PageHeader } from "@/components/DashboardShell";
import { AppearancePanel, DisconnectStripeButton, EmailsTogglePanel } from "@/components/dashboard/SettingsPanels";
import { WidgetKeysCard } from "@/components/dashboard/WidgetKeysCard";
import { DeleteAccountCard } from "@/components/dashboard/DeleteAccountCard";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Kbd } from "@/components/ui/input";
import { getOrCreateAccount, getWidgetKeys } from "@/lib/accounts";
import { loadDunningSettingsRow } from "@/lib/dunning/repo";
import { settingsFromRow } from "@/lib/dunning/settings";
import { getSessionUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const db = getDb();
  const user = await getSessionUser();
  if (!user) redirect("/login?next=/dashboard/settings");

  const account = await getOrCreateAccount(db, user);
  const connected = account.stripe_connection_status === "connected" && !!account.stripe_account_id;
  const [keys, dunning] = await Promise.all([
    connected ? getWidgetKeys(db, account.id) : Promise.resolve(null),
    loadDunningSettingsRow(db, account.id),
  ]);
  const settings = settingsFromRow(dunning);
  const defaultCompany = account.name && !account.name.includes("@") ? account.name : null;

  return (
    <div className="space-y-6">
      <PageHeader title="Settings" description="Your Stripe connection, widget keys, emails and how the dashboard looks." className="mb-2" />

      <Card>
        <CardHeader>
          <div>
            <CardTitle>Stripe</CardTitle>
            <CardDescription>unquit works on the subscriptions in this account.</CardDescription>
          </div>
          {connected ? <DisconnectStripeButton /> : null}
        </CardHeader>
        <CardContent className="flex flex-wrap items-center justify-between gap-4">
          {connected ? (
            <dl className="grid gap-4 text-sm sm:grid-cols-4">
              <div>
                <dt className="text-2xs uppercase tracking-wider text-muted-foreground">Account</dt>
                <dd className="mt-1 font-mono text-xs text-foreground">{account.stripe_account_id}</dd>
              </div>
              <div>
                <dt className="text-2xs uppercase tracking-wider text-muted-foreground">Mode</dt>
                <dd className="mt-1">
                  {account.stripe_livemode === false ? <Badge tone="warning" dot>Test mode</Badge> : <Badge tone="success" dot>Live</Badge>}
                </dd>
              </div>
              <div>
                <dt className="text-2xs uppercase tracking-wider text-muted-foreground">Connected with</dt>
                <dd className="mt-1 text-foreground">
                  {account.stripe_connection_mode === "key" ? (
                    <>
                      Restricted key <span className="font-mono text-xs">••••{account.stripe_key_last4}</span>
                    </>
                  ) : (
                    "Stripe Connect"
                  )}
                </dd>
              </div>
              <div>
                <dt className="text-2xs uppercase tracking-wider text-muted-foreground">Connected</dt>
                <dd className="mt-1 text-foreground">
                  {account.stripe_connected_at ? new Date(account.stripe_connected_at).toLocaleDateString("en-US", { dateStyle: "medium" }) : "—"}
                </dd>
              </div>
            </dl>
          ) : (
            <>
              <p className="text-sm text-muted-foreground">
                Not connected yet. No Stripe Connect?{" "}
                <a href="/dashboard#restricted-key" className="font-medium text-brand-text underline-offset-4 hover:underline">
                  Use a restricted key
                </a>
                .
              </p>
              <Button asChild variant="brand">
                {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
                <a href="/api/stripe/connect">
                  Connect Stripe <ArrowRight className="h-4 w-4" />
                </a>
              </Button>
            </>
          )}
        </CardContent>
      </Card>

      {keys ? <WidgetKeysCard publishableKey={keys.widget_publishable_key} signingSecret={keys.widget_signing_secret} /> : null}

      <Card>
        <CardHeader>
          <div>
            <CardTitle>Failed-payment emails</CardTitle>
            <CardDescription>Switch the sequence on or off. Saved instantly.</CardDescription>
          </div>
        </CardHeader>
        <CardContent>
          <EmailsTogglePanel initial={{ ...settings, companyName: settings.companyName ?? defaultCompany }} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div>
            <CardTitle>Appearance</CardTitle>
            <CardDescription>Follows your system until you pick one. Saved in this browser.</CardDescription>
          </div>
        </CardHeader>
        <CardContent>
          <AppearancePanel />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div>
            <CardTitle>Account</CardTitle>
            <CardDescription>Signed in with email and password as {user.email}.</CardDescription>
          </div>
        </CardHeader>
        <CardContent className="flex flex-wrap items-center justify-between gap-3">
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Keyboard className="h-4 w-4" /> Press <Kbd>?</Kbd> anywhere for keyboard shortcuts, <Kbd>⌘K</Kbd> to jump.
          </p>
          <form action="/auth/signout" method="post">
            <Button variant="secondary" size="sm" type="submit">
              <LogOut className="h-4 w-4" /> Sign out
            </Button>
          </form>
        </CardContent>
      </Card>

      <DeleteAccountCard email={user.email} />
    </div>
  );
}
