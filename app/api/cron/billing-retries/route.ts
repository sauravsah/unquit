import { NextResponse } from "next/server";
import { dodoConfigured, dodoDeps } from "@/lib/billing/dodo/runtime";
import { chargeDue } from "@/lib/billing/dodo/service";
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
 * outcome never arrived. Idempotent: every attempt is claimed before it is sent.
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
    const summary = await chargeDue(dodoDeps(getDb()));
    console.info("[cron/billing-retries]", JSON.stringify(summary));
    return NextResponse.json({ ok: true, ...summary }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[cron/billing-retries] run failed", message);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
