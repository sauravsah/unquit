import "server-only";
import { attempt, queryOne, type Db } from "@/lib/db/core";
import { isInstallToken } from "./token";

/**
 * What the PUBLIC developer page (/install/<token>) may know about a founder:
 * the publishable key and nothing else. It is safe in a web page by design.
 * Never add the signing secret, the account id, an email or any dashboard data here.
 */
export type PublicInstallView = { publishableKey: string };

/** The founder's own share-link token (their account only). */
export async function getInstallLinkToken(db: Db, accountId: string): Promise<string> {
  const row = await attempt("Loading setup link", () =>
    queryOne<{ install_link_token: string }>(db, "select install_link_token from accounts where id = $1", [accountId]),
  );
  if (!row) throw new Error("Loading setup link failed: account not found");
  return row.install_link_token;
}

/** A new share-link token for the founder's own account; the old link stops working at once. */
export async function rotateInstallLinkToken(db: Db, accountId: string): Promise<boolean> {
  const rows = await attempt("Rotating setup link", () =>
    db.query<{ id: string }>("update accounts set install_link_token = new_install_link_token() where id = $1 returning id", [accountId]),
  );
  return rows.length > 0;
}

/** Loads the public developer page for a share-link token, or null (bad, tampered or rotated token). */
export async function loadPublicInstallView(db: Db, token: unknown): Promise<PublicInstallView | null> {
  if (!isInstallToken(token)) return null;
  // Select ONLY the publishable key: the secret never leaves the database on this path.
  const row = await attempt("Loading setup page", () =>
    queryOne<{ widget_publishable_key: string }>(db, "select widget_publishable_key from accounts where install_link_token = $1", [token]),
  );
  return row ? { publishableKey: row.widget_publishable_key } : null;
}
