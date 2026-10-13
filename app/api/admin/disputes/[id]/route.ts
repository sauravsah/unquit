import { NextResponse } from "next/server";
import { isAdminEmail } from "@/lib/env";
import { isSameOrigin } from "@/lib/http";
import { DisputeError, resolveDispute } from "@/lib/ledger/disputes";
import { ledgerDeps } from "@/lib/ledger/runtime";
import { getSessionUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** An admin accepts (fees reversed) or rejects (with a note) a dispute from /admin. */
export async function POST(request: Request, { params }: { params: { id: string } }) {
  if (!isSameOrigin(request)) return NextResponse.json({ error: "Bad origin" }, { status: 403 });
  const db = getDb();
  const user = await getSessionUser();
  // Same answer for "signed out" and "not an admin": the queue's existence isn't advertised.
  if (!user || !isAdminEmail(user.email)) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const form = await request.formData().catch(() => null);
  const decision = form?.get("decision");
  const note = form?.get("note");
  const back = (state: string) => NextResponse.redirect(new URL(`/admin?result=${state}`, request.url), { status: 303 });
  if (decision !== "accept" && decision !== "reject") return back("bad_decision");
  if (!/^[0-9a-f-]{36}$/i.test(params.id)) return back("not_found");

  try {
    await resolveDispute(ledgerDeps(db), {
      disputeId: params.id,
      decision,
      note: typeof note === "string" ? note : null,
      resolvedBy: user.email,
      resolution: "admin",
    });
    return back(decision === "accept" ? "accepted" : "rejected");
  } catch (e) {
    if (e instanceof DisputeError) return back(e.code);
    console.error("[admin/disputes] failed", e);
    return back("error");
  }
}
