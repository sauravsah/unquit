import { NextResponse } from "next/server";
import { dodoConfigured, dodoDeps } from "@/lib/billing/dodo/runtime";
import { attemptCharge, chargeDue } from "@/lib/billing/dodo/service";
import { adminPauseDeps } from "@/lib/billing/pause-runtime";
import { findAccountForAdmin, pauseAccount, resumeAccount } from "@/lib/billing/pause";
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
 *   action=pause   account=<id|owner email>   pause Unquit for that founder now
 *                                   (offers off, no dunning; only an admin resumes it)
 *   action=resume  account=<id|owner email>   resume now (clears a warning too)
 */
export async function POST(request: Request) {
  if (!isSameOrigin(request)) return NextResponse.json({ error: "Bad origin" }, { status: 403 });
  const user = await getSessionUser();
  if (!user || !isAdminEmail(user.email)) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const back = (result: string) => NextResponse.redirect(new URL(`/admin?billing=${encodeURIComponent(result)}#billing`, request.url), { status: 303 });
  const form = await request.formData();
  const action = String(form.get("action") ?? "");

  // Pausing works without Dodo (it only needs the database and the mailer).
  if (action === "pause" || action === "resume") {
    try {
      const db = getDb();
      const accountId = await findAccountForAdmin(db, String(form.get("account") ?? ""));
      if (!accountId) return back("account_not_found");
      const deps = adminPauseDeps(db);
      const changed = action === "pause" ? await pauseAccount(deps, accountId, "admin") : await resumeAccount(deps, accountId, "admin");
      return back(changed ? `${action}d` : `already_${action === "pause" ? "paused" : "active"}`);
    } catch (error) {
      console.error("[admin/billing] pause/resume failed", error);
      return back("error");
    }
  }

  if (!dodoConfigured()) return back("not_configured");
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
