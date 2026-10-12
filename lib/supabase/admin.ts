import "server-only";
import { createClient } from "@supabase/supabase-js";
import { publicEnv, serverEnv } from "@/lib/env";

/**
 * Service-role Supabase client. BYPASSES row-level security.
 * Only for trusted server code (Stripe webhook, OAuth callback).
 * Never expose it to the browser.
 */
export function createSupabaseAdminClient() {
  return createClient(publicEnv.supabaseUrl(), serverEnv.supabaseServiceRoleKey(), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
