import "server-only";
import { attempt, type Db } from "@/lib/db/core";
import { DISPUTE_COLUMNS, SAVE_COLUMNS, type DisputeRow, type SaveRow } from "@/lib/ledger/types";

export type AdminDispute = DisputeRow & { save: SaveRow | null; accountName: string | null };

/**
 * The review queue. Deliberately NOT scoped to one account: admins see every
 * founder's disputes. Only call this after isAdminEmail() passed.
 */
export async function loadAdminQueue(db: Db): Promise<{ open: AdminDispute[]; recent: AdminDispute[] }> {
  const [open, recent] = await Promise.all([
    attempt("Loading disputes", () =>
      db.query<DisputeRow>(`select ${DISPUTE_COLUMNS} from disputes where status = 'open' order by created_at asc limit 100`),
    ),
    attempt("Loading disputes", () =>
      db.query<DisputeRow>(`select ${DISPUTE_COLUMNS} from disputes where status <> 'open' order by resolved_at desc nulls last limit 20`),
    ),
  ]);
  const all = [...open, ...recent];
  const saveIds = [...new Set(all.map((d) => d.save_id))];
  const accountIds = [...new Set(all.map((d) => d.account_id))];
  const [saves, accounts] = await Promise.all([
    saveIds.length
      ? attempt("Loading saves", () => db.query<SaveRow>(`select ${SAVE_COLUMNS} from saves where id = any($1)`, [saveIds]))
      : Promise.resolve([] as SaveRow[]),
    accountIds.length
      ? attempt("Loading accounts", () => db.query<{ id: string; name: string | null }>("select id, name from accounts where id = any($1)", [accountIds]))
      : Promise.resolve([] as { id: string; name: string | null }[]),
  ]);
  const saveById = new Map(saves.map((s) => [s.id, s]));
  const nameById = new Map(accounts.map((a) => [a.id, a.name]));
  const enrich = (d: DisputeRow): AdminDispute => ({ ...d, save: saveById.get(d.save_id) ?? null, accountName: nameById.get(d.account_id) ?? null });
  return { open: open.map(enrich), recent: recent.map(enrich) };
}
