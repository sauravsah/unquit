import { NextResponse } from "next/server";
import { isSameOrigin } from "@/lib/http";
import { getSessionUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db";
import { findAccountForUser, rotateWidgetSigningSecret } from "@/lib/accounts";

export const dynamic = "force-dynamic";

/** Replaces the founder's widget signing secret (e.g. after a leak). */
export async function POST(request: Request) {
  if (!isSameOrigin(request)) return NextResponse.json({ error: "Bad origin" }, { status: 403 });

  const db = getDb();
  const user = await getSessionUser();
  if (!user) return NextResponse.redirect(new URL("/login", request.url), 303);

  // Only ever the signed-in founder's own account.
  let ok = false;
  try {
    const account = await findAccountForUser(db, user.id);
    ok = !!account && (await rotateWidgetSigningSecret(db, account.id));
  } catch (error) {
    console.error("[dashboard/rotate-secret] failed", error instanceof Error ? error.message : error);
  }
  return NextResponse.redirect(new URL(`/dashboard?widget=${ok ? "secret_rotated" : "rotate_failed"}`, request.url), 303);
}
