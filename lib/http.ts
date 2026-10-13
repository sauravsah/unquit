import { publicEnv } from "@/lib/env";

/**
 * Basic CSRF guard for state-changing POST routes: the request must come from
 * our own site. (Auth.js session cookies are SameSite=Lax as a second layer.)
 */
export function isSameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return false;
  try {
    const allowed = new URL(publicEnv.appUrl()).origin;
    const requestOrigin = new URL(request.url).origin;
    return origin === allowed || origin === requestOrigin;
  } catch {
    return false;
  }
}
