import { NextResponse } from "next/server";
import { isSameOrigin } from "@/lib/http";
import { getDb } from "@/lib/db";
import { getSessionUser } from "@/lib/auth/session";
import { clearFirebaseSession, verifyFirebaseToken } from "@/lib/auth/firebase";

export const dynamic = "force-dynamic";

/** Permanently removes the Unquit tenant and its Firebase identity. */
export async function POST(request: Request) {
  if (!isSameOrigin(request)) return NextResponse.json({ error: "Bad origin." }, { status: 403 });
  const session = await getSessionUser();
  if (!session) return NextResponse.json({ error: "Sign in required." }, { status: 401 });
  const body = await request.json().catch(() => ({})) as { confirmation?: unknown; idToken?: unknown };
  if (body.confirmation !== "DELETE" || typeof body.idToken !== "string") return NextResponse.json({ error: "Type DELETE and confirm your password." }, { status: 400 });

  try {
    const claims = await verifyFirebaseToken(body.idToken);
    if (!claims.email || claims.email !== session.email) return NextResponse.json({ error: "The confirmation session does not match this account." }, { status: 403 });
    const apiKey = process.env.NEXT_PUBLIC_FIREBASE_API_KEY;
    if (!apiKey) throw new Error("Firebase is not configured.");
    const firebase = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:delete?key=${apiKey}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ idToken: body.idToken }) });
    if (!firebase.ok) return NextResponse.json({ error: "We couldn’t confirm the Firebase account. Please sign in again." }, { status: 401 });
    await getDb().query("delete from users where id = $1", [session.id]);
    clearFirebaseSession();
    return NextResponse.json({ deleted: true }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("[account/delete] failed", error instanceof Error ? error.message : error);
    return NextResponse.json({ error: "We couldn’t delete your account. Please try again." }, { status: 500 });
  }
}
