import "server-only";
import type { SupabaseClient, User } from "@supabase/supabase-js";

export type Account = {
  id: string;
  owner_user_id: string;
  name: string | null;
  stripe_account_id: string | null;
  stripe_connection_status: "not_connected" | "connected" | "disconnected" | "revoked";
  stripe_livemode: boolean | null;
  stripe_connected_at: string | null;
  created_at: string;
};

const ACCOUNT_COLUMNS =
  "id, owner_user_id, name, stripe_account_id, stripe_connection_status, stripe_livemode, stripe_connected_at, created_at";

/**
 * Returns the signed-in founder's account, creating it on first visit.
 * Uses the founder's own (RLS-bound) client, so it can only ever see or
 * create their own row.
 */
export async function getOrCreateAccount(supabase: SupabaseClient, user: User): Promise<Account> {
  const existing = await supabase.from("accounts").select(ACCOUNT_COLUMNS).eq("owner_user_id", user.id).maybeSingle();
  if (existing.error) throw new Error(`Loading account failed: ${existing.error.message}`);
  if (existing.data) return existing.data as Account;

  const created = await supabase
    .from("accounts")
    .insert({ owner_user_id: user.id, name: user.email ?? null })
    .select(ACCOUNT_COLUMNS)
    .single();

  if (created.error) {
    // Two tabs racing on first sign-in: the other one won, so read it back.
    if (created.error.code === "23505") {
      const again = await supabase.from("accounts").select(ACCOUNT_COLUMNS).eq("owner_user_id", user.id).single();
      if (again.error) throw new Error(`Loading account failed: ${again.error.message}`);
      return again.data as Account;
    }
    throw new Error(`Creating account failed: ${created.error.message}`);
  }
  return created.data as Account;
}

/** Only allow redirects to paths on this site (blocks open-redirect tricks). */
export function safeNextPath(next: string | null | undefined, fallback = "/dashboard"): string {
  if (!next || !next.startsWith("/") || next.startsWith("//") || next.startsWith("/\\")) return fallback;
  return next;
}

export type WidgetKeys = { widget_publishable_key: string; widget_signing_secret: string };

/** The founder's widget keys (RLS: only ever their own row). */
export async function getWidgetKeys(supabase: SupabaseClient, accountId: string): Promise<WidgetKeys> {
  const { data, error } = await supabase
    .from("accounts")
    .select("widget_publishable_key, widget_signing_secret")
    .eq("id", accountId)
    .single();
  if (error) throw new Error(`Loading widget keys failed: ${error.message}`);
  return data as WidgetKeys;
}
