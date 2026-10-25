import { NextResponse } from "next/server";
import { getOrCreateAccount } from "@/lib/accounts";
import { getSessionUser } from "@/lib/auth/session";
import { createBillingRepo } from "@/lib/billing/repo";
import { ensurePlatformCustomer } from "@/lib/billing/service";
import { createBillingStripe } from "@/lib/billing/stripe-ops";
import { getDb } from "@/lib/db";
import { isSameOrigin } from "@/lib/http";
import { underRateLimit } from "@/lib/rate-limit";
import { getStripe } from "@/lib/stripe/client";
import { KeyConnectError, connectWithRestrictedKey } from "@/lib/stripe/key-connect";
import { keyConnectDeps } from "@/lib/stripe/key-runtime";
import { KeyValidationError } from "@/lib/stripe/restricted-key";
import { assertTestMode } from "@/lib/env";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Connect with a Stripe restricted key (the alternative to Stripe Connect).
 * Body: { restrictedKey: "rk_…", publishableKey: "pk_…" }. The key is
 * validated against Stripe, stored encrypted, and never sent back: the
 * response carries only the account id, the mode and the key's last 4.
 */
export async function POST(request: Request) {
  if (!isSameOrigin(request)) return NextResponse.json({ error: "Bad origin" }, { status: 403 });

  const db = getDb();
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Please sign in again." }, { status: 401 });

  const body = (await request.json().catch(() => null)) as { restrictedKey?: unknown; publishableKey?: unknown } | null;
  const restrictedKey = typeof body?.restrictedKey === "string" ? body.restrictedKey : "";
  const publishableKey = typeof body?.publishableKey === "string" ? body.publishableKey : "";
  try {
    assertTestMode("Stripe restricted key", restrictedKey);
    if (publishableKey) assertTestMode("Stripe publishable key", publishableKey);
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Live Stripe credentials are disabled during the beta.", code: "live_mode_disabled" }, { status: 400 });
  }
  if (!restrictedKey.trim()) return NextResponse.json({ error: "Paste your restricted key (it starts with rk_).", code: "not_restricted" }, { status: 400 });

  const account = await getOrCreateAccount(db, user);
  // Each attempt makes about a dozen Stripe calls: 10 tries per 10 minutes is plenty.
  if (!(await underRateLimit(db, `rk:${account.id}`, 600, 10, "stripe/key"))) {
    return NextResponse.json({ error: "Too many attempts. Please wait a few minutes and try again.", code: "rate_limited" }, { status: 429 });
  }

  try {
    const result = await connectWithRestrictedKey(keyConnectDeps(db), { accountId: account.id, restrictedKey, publishableKey });
    try {
      await ensurePlatformCustomer(createBillingRepo(db), createBillingStripe(getStripe()), account.id);
    } catch (customerError) {
      console.warn("[stripe/key] creating the platform customer failed; it will be created on first bill", customerError);
    }
    return NextResponse.json({ ok: true, stripeAccountId: result.stripeAccountId, livemode: result.livemode, keyLast4: result.keyLast4 });
  } catch (error) {
    if (error instanceof KeyValidationError) {
      return NextResponse.json(
        { error: error.message, code: error.code, missing: error.missing.map((p) => ({ id: p.id, resource: p.resource, level: p.level })) },
        { status: error.code === "stripe_unreachable" ? 502 : 400 },
      );
    }
    if (error instanceof KeyConnectError) {
      const status = error.code === "not_configured" ? 503 : error.code === "already_connected_elsewhere" ? 409 : 502;
      return NextResponse.json({ error: error.message, code: error.code }, { status });
    }
    console.error("[stripe/key] connect failed", error instanceof Error ? error.message : error);
    return NextResponse.json({ error: "Something went wrong connecting Stripe. Please try again.", code: "unknown" }, { status: 500 });
  }
}
