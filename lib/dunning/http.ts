import "server-only";
import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { isSameOrigin } from "@/lib/http";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { clientIp } from "@/lib/widget/http";
import { CardUpdateError, type CardUpdateDeps, type PayResult } from "./card-update";
import { cardUpdateDeps } from "./runtime";

const NO_STORE = { "Cache-Control": "no-store" };

/** Constant-time check of Vercel Cron's "Authorization: Bearer <CRON_SECRET>". */
export function isAuthorizedCron(request: Request, secret: string): boolean {
  const header = request.headers.get("authorization") ?? "";
  const expected = Buffer.from(`Bearer ${secret}`);
  const given = Buffer.from(header);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/** The card-update page's own API: same-origin POSTs, rate limited per IP and per link. */
export async function runCardUpdateAction(
  request: Request,
  token: string,
  action: (deps: CardUpdateDeps, body: Record<string, unknown>) => Promise<PayResult | { status: "ready"; clientSecret: string; stripeAccount: string }>,
): Promise<NextResponse> {
  if (!isSameOrigin(request)) return NextResponse.json({ error: "bad_origin" }, { status: 403, headers: NO_STORE });

  const admin = createSupabaseAdminClient();
  for (const [bucket, max] of [
    [`u-ip:${clientIp(request)}`, 30],
    [`u-link:${token.slice(-24)}`, 20],
  ] as const) {
    const { data, error } = await admin.rpc("widget_rate_limit_hit", { p_bucket: bucket, p_window_seconds: 600, p_max: max });
    if (error) console.error("[u] rate limiter unavailable", error.message);
    else if (data === false) {
      return NextResponse.json(
        { status: "failed", message: "Too many attempts. Please wait a few minutes and try again." },
        { status: 429, headers: NO_STORE },
      );
    }
  }

  const body = ((await request.json().catch(() => null)) ?? {}) as Record<string, unknown>;
  try {
    const result = await action(cardUpdateDeps(admin), body);
    return NextResponse.json(result, { headers: NO_STORE });
  } catch (error) {
    if (error instanceof CardUpdateError) {
      return NextResponse.json({ status: "failed", message: error.message }, { status: error.status, headers: NO_STORE });
    }
    console.error("[u] card update failed", error);
    return NextResponse.json(
      { status: "failed", message: "Something went wrong on our side. Your card was not charged twice; please try again." },
      { status: 500, headers: NO_STORE },
    );
  }
}
