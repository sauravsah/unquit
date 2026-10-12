import { NextResponse } from "next/server";
import { isAuthorizedCron } from "@/lib/dunning/http";
import { sequenceDeps } from "@/lib/dunning/runtime";
import { runDunningSequence } from "@/lib/dunning/service";
import { serverEnv } from "@/lib/env";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * Vercel Cron (see vercel.json) calls this with
 * "Authorization: Bearer <CRON_SECRET>". It sends every dunning email that is
 * due. Safe to run more often or twice at once: each email is claimed in the
 * database before sending and carries a Resend idempotency key.
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
    const summary = await runDunningSequence(sequenceDeps(createSupabaseAdminClient()), { limit: 200 });
    console.info("[cron/dunning]", JSON.stringify(summary));
    return NextResponse.json({ ok: true, ...summary }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[cron/dunning] run failed", message);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
