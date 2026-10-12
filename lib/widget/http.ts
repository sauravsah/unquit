import "server-only";
import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getStripe } from "@/lib/stripe/client";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
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
async function underLimit(admin: SupabaseClient, bucket: string, limit: { windowSeconds: number; max: number }) {
  const { data, error } = await admin.rpc("widget_rate_limit_hit", {
    p_bucket: bucket,
    p_window_seconds: limit.windowSeconds,
    p_max: limit.max,
  });
  if (error) {
    console.error("[widget] rate limiter unavailable", error.message);
    return true;
  }
  return data !== false;
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

  const admin = createSupabaseAdminClient();

  if (!(await underLimit(admin, `ip:${clientIp(request)}`, RATE_LIMITS.ip))) {
    return fail(429, "rate_limited", "Too many requests. Please wait a minute and try again.");
  }

  const { publishableKey, customerId, subscriptionId, hmac } = body;
  if (typeof publishableKey !== "string" || !/^pk_[a-z0-9]{32}$/.test(publishableKey)) {
    return fail(401, "bad_key", "This cancel flow isn't set up correctly.");
  }

  const { data: account, error } = await admin
    .from("accounts")
    .select("id, stripe_account_id, widget_signing_secret")
    .eq("widget_publishable_key", publishableKey)
    .eq("stripe_connection_status", "connected")
    .maybeSingle();
  if (error) {
    console.error(`[widget/${name}] account lookup failed`, error.message);
    return fail(500, "unavailable", "Something went wrong. Please try again.");
  }
  const acct = account as AccountRow | null;
  if (!acct?.stripe_account_id) return fail(401, "bad_key", "This cancel flow isn't set up correctly.");

  if (!verifyCustomerHmac(acct.widget_signing_secret, customerId, subscriptionId, hmac)) {
    return fail(401, "bad_signature", "This cancel flow isn't set up correctly.");
  }

  const ctx: WidgetAuthContext = {
    accountId: acct.id,
    customerId: customerId as string,
    subscriptionId: subscriptionId as string,
  };

  if (!(await underLimit(admin, `sub:${acct.id}:${ctx.subscriptionId}`, RATE_LIMITS.subscription))) {
    return fail(429, "rate_limited", "Too many requests. Please wait a few minutes and try again.");
  }

  const deps: WidgetDeps = {
    repo: createWidgetRepo(admin),
    stripe: createStripeOps(getStripe(), acct.stripe_account_id),
  };

  try {
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
