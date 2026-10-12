import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { DISPUTE_COLUMNS, SAVE_COLUMNS, type DisputeRow, type SaveRow } from "@/lib/ledger/types";

export type AdminDispute = DisputeRow & { save: SaveRow | null; accountName: string | null };

/** The review queue (service role: admins see every founder's disputes). */
export async function loadAdminQueue(admin: SupabaseClient): Promise<{ open: AdminDispute[]; recent: AdminDispute[] }> {
  const [open, recent] = await Promise.all([
    admin.from("disputes").select(DISPUTE_COLUMNS).eq("status", "open").order("created_at", { ascending: true }).limit(100),
    admin.from("disputes").select(DISPUTE_COLUMNS).neq("status", "open").order("resolved_at", { ascending: false }).limit(20),
  ]);
  if (open.error) throw new Error(`Loading disputes failed: ${open.error.message}`);
  if (recent.error) throw new Error(`Loading disputes failed: ${recent.error.message}`);
  const all = [...((open.data ?? []) as DisputeRow[]), ...((recent.data ?? []) as DisputeRow[])];
  const saveIds = [...new Set(all.map((d) => d.save_id))];
  const accountIds = [...new Set(all.map((d) => d.account_id))];
  const [saves, accounts] = await Promise.all([
    saveIds.length ? admin.from("saves").select(SAVE_COLUMNS).in("id", saveIds) : Promise.resolve({ data: [], error: null }),
    accountIds.length ? admin.from("accounts").select("id, name").in("id", accountIds) : Promise.resolve({ data: [], error: null }),
  ]);
  if (saves.error) throw new Error(`Loading saves failed: ${saves.error.message}`);
  if (accounts.error) throw new Error(`Loading accounts failed: ${accounts.error.message}`);
  const saveById = new Map(((saves.data ?? []) as SaveRow[]).map((s) => [s.id, s]));
  const nameById = new Map(((accounts.data ?? []) as { id: string; name: string | null }[]).map((a) => [a.id, a.name]));
  const enrich = (d: DisputeRow): AdminDispute => ({ ...d, save: saveById.get(d.save_id) ?? null, accountName: nameById.get(d.account_id) ?? null });
  return { open: ((open.data ?? []) as DisputeRow[]).map(enrich), recent: ((recent.data ?? []) as DisputeRow[]).map(enrich) };
}
