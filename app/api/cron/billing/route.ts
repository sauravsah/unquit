import { NextResponse } from "next/server";
import { dodoCollector, dodoConfigured, dodoDeps } from "@/lib/billing/dodo/runtime";
import { chargeDue } from "@/lib/billing/dodo/service";
import { runPauseSweep } from "@/lib/billing/pause";
import { runMonthlyBilling } from "@/lib/billing/service";
import { isAuthorizedCron } from "@/lib/dunning/http";
import { serverEnv } from "@/lib/env";
import { monthFromSlug } from "@/lib/ledger/fees";
import { billingDeps } from "@/lib/ledger/runtime";
import { getDb } from "@/lib/db";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * Vercel Cron (vercel.json, 06:00 UTC on the 1st) calls this with
 * "Authorization: Bearer <CRON_SECRET>".
 *
 *   1. closes every founder's statement for the month that just ended
 *      (fees after clawbacks, the $299 cap, earlier credits; idempotent per
 *      founder and month in billing_periods)
 *   2. charges each statement due >= $1 to the founder's saved card through
 *      Dodo Payments: one charge row per statement, each attempt claimed
 *      before it is sent, so a retry of this cron never charges twice.
 *      Smaller amounts carry forward; $0 months get a statement only.
 *
 * `?month=2026-09` re-runs a specific past month (still idempotent).
 */
export async function GET(request: Request) {
  let secret: string;
  try {
    secret = serverEnv.cronSecret();
  } catch {
    return NextResponse.json({ error: "CRON_SECRET is not set" }, { status: 500 });
  }
  if (!isAuthorizedCron(request, secret)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const slug = new URL(request.url).searchParams.get("month");
  const month = slug ? monthFromSlug(slug) : undefined;
  if (slug && !month) return NextResponse.json({ error: "month must look like 2026-09" }, { status: 400 });

  const db = getDb();
  try {
    const statements = await runMonthlyBilling(billingDeps(db, dodoCollector(db)), { month: month ?? undefined });
    console.info("[cron/billing] statements", JSON.stringify(statements));
    let charges: unknown = { skipped: "Dodo Payments is not configured" };
    if (dodoConfigured()) {
      try {
        const deps = dodoDeps(db);
        charges = await chargeDue(deps);
        charges = { ...(charges as object), pauses: await runPauseSweep(deps) };
      } catch (error) {
        charges = { error: error instanceof Error ? error.message : String(error) };
      }
    }
    console.info("[cron/billing] charges", JSON.stringify(charges));
    return NextResponse.json({ ok: true, ...statements, charges }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[cron/billing] run failed", message);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
