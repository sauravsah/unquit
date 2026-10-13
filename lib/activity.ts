import "server-only";
import { attempt, type Db } from "@/lib/db/core";
import {
  CASE_COLUMNS,
  SAVE_COLUMNS,
  SESSION_COLUMNS,
  buildActivity,
  type ActivityItem,
  type CaseActivityRow,
  type SaveActivityRow,
  type SessionActivityRow,
} from "@/components/dashboard/activity";

/**
 * The overview's activity feed for one founder account: the 15 newest saves,
 * cancel sessions and dunning cases, merged. Used by the server render and by
 * /api/dashboard/activity, which the feed polls.
 */
export async function loadActivity(db: Db, accountId: string, limit = 15): Promise<ActivityItem[]> {
  const load = <T>(text: string) => attempt("Loading activity", () => db.query<T>(text, [accountId, limit]));
  const [saves, sessions, cases] = await Promise.all([
    load<SaveActivityRow>(`select ${SAVE_COLUMNS} from saves where account_id = $1 order by created_at desc limit $2`),
    load<SessionActivityRow>(`select ${SESSION_COLUMNS} from cancel_sessions where account_id = $1 order by started_at desc limit $2`),
    load<CaseActivityRow>(`select ${CASE_COLUMNS} from dunning_cases where account_id = $1 order by opened_at desc limit $2`),
  ]);
  return buildActivity(saves, sessions, cases);
}
