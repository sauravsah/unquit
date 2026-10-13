import { NextResponse } from "next/server";
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
 * "Authorization: Bearer <CRON_SECRET>". It bills every founder for the month
 * that just ended: one Stripe Invoice each on unquit's platform account, $0
 * months get a statement only. Idempotent per founder and month
 * (billing_periods), so a retry or a second run never bills twice.
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

  try {
    const summary = await runMonthlyBilling(billingDeps(getDb()), { month: month ?? undefined });
    console.info("[cron/billing]", JSON.stringify(summary));
    return NextResponse.json({ ok: true, ...summary }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[cron/billing] run failed", message);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
