import { NextResponse, type NextRequest } from "next/server";
import { jwtVerify } from "jose";

/** Paths that require a signed-in founder. */
const PROTECTED_PREFIXES = ["/dashboard", "/admin"];

function isProtectedPath(pathname: string): boolean {
  return PROTECTED_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

/**
 * Sends signed-out visitors from protected pages to /login. The session is an
 * Auth.js JWT cookie, verified here with AUTH_SECRET (no database call).
 * Pages and API routes still check the session themselves.
 */
export async function middleware(request: NextRequest) {
  if (!isProtectedPath(request.nextUrl.pathname)) return NextResponse.next();

  const secret = process.env.AUTH_SECRET || process.env.NEXTAUTH_SECRET;
  if (!secret) {
    // Not configured yet: never leak protected pages, just send to sign-in.
    return NextResponse.redirect(new URL("/login?error=not_configured", request.url));
  }

  const name = process.env.NODE_ENV === "production" ? "__Secure-unquit.session" : "unquit.session";
  const token = request.cookies.get(name)?.value;
  const session = token ? await jwtVerify(token, new TextEncoder().encode(secret)).catch(() => null) : null;
  if (!session?.payload.sub) {
    const loginUrl = new URL("/login", request.url);
    loginUrl.searchParams.set("next", `${request.nextUrl.pathname}${request.nextUrl.search}`);
    return NextResponse.redirect(loginUrl);
  }
  return NextResponse.next();
}

export const config = {
  // Only pages that need a founder session. Webhooks, the widget API, cron,
  // the card-update page (/u/<token>, /api/u/*) and dunning tracking links
  // never go through here.
  matcher: ["/dashboard/:path*", "/admin/:path*"],
};
