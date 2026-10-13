import { NextResponse } from "next/server";
import { findAccountForUser } from "@/lib/accounts";
import { loadActivity } from "@/lib/activity";
import { getSessionUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * The overview's live activity feed, polled by components/dashboard/LiveActivity.
 * Always the signed-in founder's own account: the client never names an account.
 */
export async function GET() {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Please sign in again." }, { status: 401, headers: NO_STORE });
  const db = getDb();
  try {
    const account = await findAccountForUser(db, user.id);
    if (!account) return NextResponse.json({ items: [] }, { headers: NO_STORE });
    return NextResponse.json({ items: await loadActivity(db, account.id) }, { headers: NO_STORE });
  } catch (error) {
    console.error("[dashboard/activity] failed", error instanceof Error ? error.message : error);
    return NextResponse.json({ error: "Loading activity failed" }, { status: 500, headers: NO_STORE });
  }
}
