import { NextResponse } from "next/server";
import { dodoConfigured, dodoDeps } from "@/lib/billing/dodo/runtime";
import { attemptCharge, chargeDue } from "@/lib/billing/dodo/service";
import { isAdminEmail } from "@/lib/env";
import { isSameOrigin } from "@/lib/http";
import { getSessionUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Admin-only billing actions from /admin:
 *   action=charge_now  charge_id=…  one attempt now on a scheduled/retrying charge
 *                                   (still claimed, so it can't double-charge)
 *   action=run_due                  the daily run now (due charges + reconciliation)
 */
export async function POST(request: Request) {
  if (!isSameOrigin(request)) return NextResponse.json({ error: "Bad origin" }, { status: 403 });
  const user = await getSessionUser();
  if (!user || !isAdminEmail(user.email)) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const back = (result: string) => NextResponse.redirect(new URL(`/admin?billing=${encodeURIComponent(result)}#billing`, request.url), { status: 303 });
  if (!dodoConfigured()) return back("not_configured");

  const form = await request.formData();
  const action = String(form.get("action") ?? "");
  const deps = dodoDeps(getDb());
  try {
    if (action === "charge_now") {
      const chargeId = String(form.get("charge_id") ?? "");
      if (!/^[0-9a-f-]{36}$/i.test(chargeId)) return back("bad_charge");
      const out = await attemptCharge(deps, chargeId, { force: true });
      return back(out.outcome === "skipped" ? `skipped_${out.reason}` : out.outcome);
    }
    if (action === "run_due") {
      const out = await chargeDue(deps);
      return back(`ran_${out.due}`);
    }
    return back("bad_action");
  } catch (error) {
    console.error("[admin/billing] failed", error);
    return back("error");
  }
}
