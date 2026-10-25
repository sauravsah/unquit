import "server-only";
import { getServerSession } from "next-auth";
import { authOptions } from "./options";
import { readFirebaseSession } from "./firebase";

/** The signed-in founder (from the Auth.js JWT), or null. */
export type SessionUser = { id: string; email: string };

/**
 * Who is signed in, for Server Components and Route Handlers. Returns null
 * when signed out or when auth isn't configured (no AUTH_SECRET), so pages
 * redirect to /login instead of crashing.
 */
export async function getSessionUser(): Promise<SessionUser | null> {
  try {
    const firebase = await readFirebaseSession();
    if (firebase) return firebase;
    const session = await getServerSession(authOptions);
    const user = session?.user as { id?: string; email?: string | null } | undefined;
    if (!user?.id || !user.email) return null;
    return { id: user.id, email: user.email };
  } catch (error) {
    console.error("[auth] reading the session failed", error instanceof Error ? error.message : error);
    return null;
  }
}
