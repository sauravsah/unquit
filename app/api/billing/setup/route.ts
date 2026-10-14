import { NextResponse } from "next/server";
import { dodoConfigured, dodoDeps } from "@/lib/billing/dodo/runtime";
import { startBillingMethod } from "@/lib/billing/dodo/service";
import { isSameOrigin } from "@/lib/http";
import { getSessionUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db";
import { findAccountForUser } from "@/lib/accounts";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * "Add a billing card" / "Update card" on /dashboard/billing. Sends the
 * founder to Dodo Payments (merchant of record for unquit's fees):
 *   * no card yet: a Dodo checkout that creates an ON-DEMAND subscription
 *     with mandate_only: true, so nothing is charged now
 *   * card on file: Dodo's update-payment-method page for that subscription
 * Dodo brings them back to /dashboard/billing?card=…&subscription_id=…, and
 * the subscription.active webhook records the card either way.
 */
export async function POST(request: Request) {
  if (!isSameOrigin(request)) return NextResponse.json({ error: "Bad origin" }, { status: 403 });
  const db = getDb();
  const user = await getSessionUser();
  if (!user) return NextResponse.redirect(new URL("/login?next=/dashboard/billing", request.url), { status: 303 });

  const account = await findAccountForUser(db, user.id).catch(() => null);
  if (!account || !dodoConfigured()) return NextResponse.redirect(new URL("/dashboard/billing?card=error", request.url), { status: 303 });

  try {
    const { url } = await startBillingMethod(dodoDeps(db), account.id);
    return NextResponse.redirect(url, { status: 303 });
  } catch (e) {
    console.error("[billing/setup] could not start Dodo checkout", e);
    return NextResponse.redirect(new URL("/dashboard/billing?card=error", request.url), { status: 303 });
  }
}
