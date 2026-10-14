import "server-only";
import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { queryOne } from "@/lib/db/core";
import { underRateLimit } from "@/lib/rate-limit";
import { getStripeResolver } from "@/lib/stripe/client";
import { verifyCustomerHmac } from "./hmac";
import { createWidgetRepo } from "./repo";
import { WidgetError, type WidgetAuthContext, type WidgetDeps } from "./service";
import { createStripeOps } from "./stripe-ops";

/**
 * Shared plumbing for the public widget API (/api/widget/*):
 *   CORS for any origin (no cookies), body parsing, rate limiting, and
 *   authentication by publishable key + HMAC.
 */

export const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "content-type",
  "Access-Control-Max-Age": "86400",
  "Cache-Control": "no-store",
};

export function widgetJson(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: CORS_HEADERS });
}

export function widgetPreflight(): NextResponse {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
}

function fail(status: number, error: string, message: string): NextResponse {
  return widgetJson({ error, message }, status);
}

/** Per-window request limits. */
export const RATE_LIMITS = {
  /** Any widget call from one IP address. */
  ip: { windowSeconds: 60, max: 60 },
  /** Calls about one subscription (stops a script hammering one customer). */
  subscription: { windowSeconds: 600, max: 30 },
} as const;

export function clientIp(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0]!.trim();
  return request.headers.get("x-real-ip") ?? "unknown";
}

/** True while under the limit. Fails open (logs) if the counter itself is unavailable. */
function underLimit(db: ReturnType<typeof getDb>, bucket: string, limit: { windowSeconds: number; max: number }) {
  return underRateLimit(db, bucket, limit.windowSeconds, limit.max, "widget");
}

type AccountRow = { id: string; stripe_account_id: string | null; widget_signing_secret: string };

export type WidgetRequest = {
  body: Record<string, unknown>;
  ctx: WidgetAuthContext;
  deps: WidgetDeps;
};

const MAX_BODY_BYTES = 4096;

/**
 * Runs one widget endpoint: rate-limits, authenticates, then calls `handler`.
 * Known failures (WidgetError) become friendly JSON errors the widget shows
 * as-is; anything else is logged and returned as a generic 500/502.
 */
export async function runWidgetEndpoint(
  request: Request,
  name: string,
  handler: (req: WidgetRequest) => Promise<unknown>,
): Promise<NextResponse> {
  let raw: string;
  try {
    raw = await request.text();
  } catch {
    return fail(400, "bad_request", "Invalid request.");
  }
  if (raw.length > MAX_BODY_BYTES) return fail(413, "too_large", "Invalid request.");
  let body: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    body = parsed as Record<string, unknown>;
  } catch {
    return fail(400, "bad_request", "Invalid request.");
  }

  const db = getDb();

  if (!(await underLimit(db, `ip:${clientIp(request)}`, RATE_LIMITS.ip))) {
    return fail(429, "rate_limited", "Too many requests. Please wait a minute and try again.");
  }

  const { publishableKey, customerId, subscriptionId, hmac } = body;
  if (typeof publishableKey !== "string" || !/^pk_[a-z0-9]{32}$/.test(publishableKey)) {
    return fail(401, "bad_key", "This cancel flow isn't set up correctly.");
  }

  let acct: AccountRow | null;
  try {
    acct = await queryOne<AccountRow>(
      db,
      "select id, stripe_account_id, widget_signing_secret from accounts where widget_publishable_key = $1 and stripe_connection_status = 'connected'",
      [publishableKey],
    );
  } catch (error) {
    console.error(`[widget/${name}] account lookup failed`, error instanceof Error ? error.message : error);
    return fail(500, "unavailable", "Something went wrong. Please try again.");
  }
  if (!acct?.stripe_account_id) return fail(401, "bad_key", "This cancel flow isn't set up correctly.");

  if (!verifyCustomerHmac(acct.widget_signing_secret, customerId, subscriptionId, hmac)) {
    return fail(401, "bad_signature", "This cancel flow isn't set up correctly.");
  }

  const ctx: WidgetAuthContext = {
    accountId: acct.id,
    customerId: customerId as string,
    subscriptionId: subscriptionId as string,
  };

  if (!(await underLimit(db, `sub:${acct.id}:${ctx.subscriptionId}`, RATE_LIMITS.subscription))) {
    return fail(429, "rate_limited", "Too many requests. Please wait a few minutes and try again.");
  }

  try {
    const deps: WidgetDeps = {
      repo: createWidgetRepo(db),
      stripe: createStripeOps(await getStripeResolver(db)(acct.stripe_account_id)),
    };
    return widgetJson(await handler({ body, ctx, deps }));
  } catch (err) {
    if (err instanceof WidgetError) return fail(err.status, err.code, err.message);
    const stripeType = (err as { type?: string } | null)?.type;
    console.error(`[widget/${name}] failed`, err);
    if (typeof stripeType === "string" && stripeType.startsWith("Stripe")) {
      return fail(502, "stripe_error", "We couldn't update your subscription. Please try again.");
    }
    return fail(500, "unavailable", "Something went wrong. Please try again.");
  }
}
