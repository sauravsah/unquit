import { NextResponse } from "next/server";
import { dodoConfigured, dodoDeps } from "@/lib/billing/dodo/runtime";
import { chargeDue } from "@/lib/billing/dodo/service";
import { runPauseSweep } from "@/lib/billing/pause";
import { isAuthorizedCron } from "@/lib/dunning/http";
import { serverEnv } from "@/lib/env";
import { getDb } from "@/lib/db";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * Vercel Cron (vercel.json, 06:00 UTC on days 2-31, the same time of day as
 * the monthly run on the 1st). Runs the retries Dodo's safe retry policy
 * schedules (+3, +10, +17 days after the first attempt), charges statements
 * whose founder has since added a card, and reconciles attempts whose
 * outcome never arrived, then runs the pause sweep (warned accounts past their
 * 3-day grace are paused; paid ones resume). Idempotent: every attempt is
 * claimed before it is sent and every pause transition is compare-and-set.
 */
export async function GET(request: Request) {
  let secret: string;
  try {
    secret = serverEnv.cronSecret();
  } catch {
    return NextResponse.json({ error: "CRON_SECRET is not set" }, { status: 500 });
  }
  if (!isAuthorizedCron(request, secret)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!dodoConfigured()) return NextResponse.json({ ok: true, skipped: "Dodo Payments is not configured" });

  try {
    const deps = dodoDeps(getDb());
    const summary = await chargeDue(deps);
    // After the retries: pause accounts whose 3-day grace ended, resume any that paid (lib/billing/pause.ts).
    let pauses: unknown;
    try {
      pauses = await runPauseSweep(deps);
    } catch (error) {
      pauses = { error: error instanceof Error ? error.message : String(error) };
    }
    console.info("[cron/billing-retries]", JSON.stringify({ ...summary, pauses }));
    return NextResponse.json({ ok: true, ...summary, pauses }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[cron/billing-retries] run failed", message);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
