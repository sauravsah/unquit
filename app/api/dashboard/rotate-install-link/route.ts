import { NextResponse } from "next/server";
import { isSameOrigin } from "@/lib/http";
import { getSessionUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db";
import { findAccountForUser } from "@/lib/accounts";
import { rotateInstallLinkToken } from "@/lib/install/repo";

export const dynamic = "force-dynamic";

/** Replaces the founder's shareable developer setup link; the old /install/<token> stops working. */
export async function POST(request: Request) {
  if (!isSameOrigin(request)) return NextResponse.json({ error: "Bad origin" }, { status: 403 });

  const db = getDb();
  const user = await getSessionUser();
  if (!user) return NextResponse.redirect(new URL("/login", request.url), 303);

  // Only ever the signed-in founder's own account.
  let ok = false;
  try {
    const account = await findAccountForUser(db, user.id);
    ok = !!account && (await rotateInstallLinkToken(db, account.id));
  } catch (error) {
    console.error("[dashboard/rotate-install-link] failed", error instanceof Error ? error.message : error);
  }
  return NextResponse.redirect(new URL(`/dashboard/install?link=${ok ? "rotated" : "rotate_failed"}`, request.url), 303);
}
