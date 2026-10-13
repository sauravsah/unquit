import { NextResponse } from "next/server";
import { isAuthorizedCron } from "@/lib/dunning/http";
import { sequenceDeps } from "@/lib/dunning/runtime";
import { runDunningSequence } from "@/lib/dunning/service";
import { serverEnv } from "@/lib/env";
import { runDailyLedgerJobs } from "@/lib/ledger/jobs";
import { billingDeps, ledgerDeps } from "@/lib/ledger/runtime";
import { verifyWindowDays } from "@/lib/saves/verify";
import { getDb } from "@/lib/db";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * Vercel Cron (see vercel.json) calls this with
 * "Authorization: Bearer <CRON_SECRET>". It sends every dunning email that is
 * due. Safe to run more often or twice at once: each email is claimed in the
 * database before sending and carries a Resend idempotency key.
 *
 * Week 4: the same daily run also keeps the save ledger tidy: pending saves
 * past their 45-day window become lost, cancel sessions left "started" for
 * 24 hours become abandoned, receipt emails go out, and last month's
 * statements are billed if the monthly run missed any (idempotent).
 */
export async function GET(request: Request) {
  let secret: string;
  try {
    secret = serverEnv.cronSecret();
  } catch {
    return NextResponse.json({ error: "CRON_SECRET is not set" }, { status: 500 });
  }
  if (!isAuthorizedCron(request, secret)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const db = getDb();
    const summary = await runDunningSequence(sequenceDeps(db), { limit: 200 });
    console.info("[cron/dunning]", JSON.stringify(summary));
    let ledger: unknown = null;
    try {
      ledger = await runDailyLedgerJobs(ledgerDeps(db), {
        verifyWindowDays: verifyWindowDays(serverEnv.verifyWindowDays()),
        billing: billingDeps(db),
      });
      console.info("[cron/ledger]", JSON.stringify(ledger));
    } catch (error) {
      ledger = { error: error instanceof Error ? error.message : String(error) };
      console.error("[cron/ledger] run failed", ledger);
    }
    return NextResponse.json({ ok: true, ...summary, ledger }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[cron/dunning] run failed", message);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
