import { NextResponse } from "next/server";
import { authCookieNames } from "@/lib/auth/cookies";
import { firebaseSessionCookieName } from "@/lib/auth/firebase";
import { isSameOrigin } from "@/lib/http";

export const dynamic = "force-dynamic";

/**
 * Signs the founder out: the session is a stateless Auth.js JWT cookie, so
 * clearing the cookies ends it. Same-origin POST only (the forms in the app
 * shell, settings and /signout post here).
 */
export async function POST(request: Request) {
  if (!isSameOrigin(request)) return NextResponse.json({ error: "Bad origin" }, { status: 403 });
  const response = NextResponse.redirect(new URL("/login?signed_out=1", request.url), 303);
  for (const name of authCookieNames()) {
    response.cookies.set(name, "", {
      path: "/",
      maxAge: 0,
      httpOnly: true,
      sameSite: "lax",
      secure: name.startsWith("__"),
    });
  }
  const firebaseCookie = firebaseSessionCookieName();
  response.cookies.set(firebaseCookie, "", { path: "/", maxAge: 0, httpOnly: true, sameSite: "lax", secure: firebaseCookie.startsWith("__") });
  return response;
}
