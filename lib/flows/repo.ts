import "server-only";
import { attempt, queryOne, run, upsertStatement, type Db } from "@/lib/db/core";
import type { FlowRow } from "./schema";

/** The founder's saved cancel flow row (null = never saved; the default flow applies). */
export async function loadFlowRow(db: Db, accountId: string): Promise<FlowRow | null> {
  return attempt("Loading flow", () =>
    queryOne<FlowRow>(db, "select template, reasons, cancel_mode, offer_cooldown_days from flows where account_id = $1", [accountId]),
  );
}

/** Saves (insert or replace) the founder's cancel flow. */
export async function saveFlowRow(db: Db, accountId: string, row: FlowRow): Promise<void> {
  await attempt("Saving flow", () => run(db, upsertStatement("flows", { account_id: accountId, ...row }, ["account_id"])));
}
