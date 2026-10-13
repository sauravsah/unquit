/**
 * Auth.js (next-auth v4) cookie names. They get the __Secure- prefix when the
 * app runs on https, which is decided the same way next-auth decides it: from
 * the public URL (NEXTAUTH_URL, AUTH_URL, NEXT_PUBLIC_APP_URL), or on Vercel.
 * Edge-safe (used by middleware): no Node APIs.
 */
export function usesSecureCookies(): boolean {
  const url = [process.env.NEXTAUTH_URL, process.env.AUTH_URL, process.env.NEXT_PUBLIC_APP_URL].find((v) => v && v.trim() !== "");
  return url ? url.trim().startsWith("https://") : !!process.env.VERCEL;
}

export function sessionCookieName(secure = usesSecureCookies()): string {
  return `${secure ? "__Secure-" : ""}next-auth.session-token`;
}

/** Every cookie Auth.js may set, to clear on sign-out. */
export function authCookieNames(): string[] {
  return [
    "next-auth.session-token",
    "__Secure-next-auth.session-token",
    "next-auth.csrf-token",
    "__Host-next-auth.csrf-token",
    "next-auth.callback-url",
    "__Secure-next-auth.callback-url",
  ];
}
