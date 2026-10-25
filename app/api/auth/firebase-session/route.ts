import { NextResponse } from "next/server";
import { isSameOrigin } from "@/lib/http";
import { createFirebaseSession, firebaseUser, verifyFirebaseToken } from "@/lib/auth/firebase";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  if (!isSameOrigin(request)) return NextResponse.json({ error: "Bad origin." }, { status: 403 });
  const body = await request.json().catch(() => ({})) as { idToken?: unknown };
  if (typeof body.idToken !== "string") return NextResponse.json({ error: "Missing sign-in token." }, { status: 400 });
  try {
    const claims = await verifyFirebaseToken(body.idToken);
    const user = await firebaseUser(claims);
    await createFirebaseSession(user);
    return NextResponse.json(user, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Couldn’t sign you in.";
    return NextResponse.json({ error: message }, { status: message.includes("Verify your email") ? 403 : 401, headers: { "Cache-Control": "no-store" } });
  }
}
