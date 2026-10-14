import "server-only";
import type { Db } from "@/lib/db/core";
import { publicEnv } from "@/lib/env";
import { createFounderMailer } from "@/lib/ledger/runtime";
import type { PauseDeps } from "./pause";

/** Pause/resume dependencies for admin actions (no Dodo configuration needed). */
export function adminPauseDeps(db: Db): PauseDeps {
  return { db, appUrl: publicEnv.appUrl(), mailer: createFounderMailer(db), log: (line) => console.info(line) };
}
