import "server-only";
import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { isSameOrigin } from "@/lib/http";
import { getDb } from "@/lib/db";
import { underRateLimit } from "@/lib/rate-limit";
import { clientIp } from "@/lib/widget/http";
import { CardUpdateError, type CardUpdateDeps, type PayResult, type SetupReady } from "./card-update";
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
  action: (deps: CardUpdateDeps, body: Record<string, unknown>) => Promise<PayResult | SetupReady>,
): Promise<NextResponse> {
  if (!isSameOrigin(request)) return NextResponse.json({ error: "bad_origin" }, { status: 403, headers: NO_STORE });

  const db = getDb();
  for (const [bucket, max] of [
    [`u-ip:${clientIp(request)}`, 30],
    [`u-link:${token.slice(-24)}`, 20],
  ] as const) {
    if (!(await underRateLimit(db, bucket, 600, max, "u"))) {
      return NextResponse.json(
        { status: "failed", message: "Too many attempts. Please wait a few minutes and try again." },
        { status: 429, headers: NO_STORE },
      );
    }
  }

  const body = ((await request.json().catch(() => null)) ?? {}) as Record<string, unknown>;
  try {
    const result = await action(cardUpdateDeps(db), body);
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
