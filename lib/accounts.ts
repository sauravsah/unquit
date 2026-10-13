import "server-only";
import { attempt, isUniqueViolation, queryOne, type Db } from "@/lib/db/core";

export type Account = {
  id: string;
  owner_user_id: string;
  name: string | null;
  stripe_account_id: string | null;
  stripe_connection_status: "not_connected" | "connected" | "disconnected" | "revoked";
  stripe_livemode: boolean | null;
  stripe_connected_at: string | null;
  created_at: string;
};

/** The signed-in founder, as the session knows them. */
export type AccountOwner = { id: string; email: string | null };

const ACCOUNT_COLUMNS =
  "id, owner_user_id, name, stripe_account_id, stripe_connection_status, stripe_livemode, stripe_connected_at, created_at";

/** The founder's account, or null before their first dashboard visit. */
export async function findAccountForUser(db: Db, userId: string): Promise<Account | null> {
  return attempt("Loading account", () => queryOne<Account>(db, `select ${ACCOUNT_COLUMNS} from accounts where owner_user_id = $1`, [userId]));
}

/**
 * Returns the signed-in founder's account, creating it on first visit. Always
 * keyed by the session's user id, so it can only ever see or create their own row.
 */
export async function getOrCreateAccount(db: Db, user: AccountOwner): Promise<Account> {
  const existing = await findAccountForUser(db, user.id);
  if (existing) return existing;

  try {
    const created = await queryOne<Account>(
      db,
      `insert into accounts (owner_user_id, name) values ($1, $2) returning ${ACCOUNT_COLUMNS}`,
      [user.id, user.email ?? null],
    );
    if (!created) throw new Error("no row returned");
    return created;
  } catch (error) {
    // Two tabs racing on first sign-in: the other one won, so read it back.
    if (isUniqueViolation(error)) {
      const again = await findAccountForUser(db, user.id);
      if (again) return again;
    }
    return attempt("Creating account", () => Promise.reject(error));
  }
}

/** Only allow redirects to paths on this site (blocks open-redirect tricks). */
export function safeNextPath(next: string | null | undefined, fallback = "/dashboard"): string {
  if (!next || !next.startsWith("/") || next.startsWith("//") || next.startsWith("/\\")) return fallback;
  return next;
}

export type WidgetKeys = { widget_publishable_key: string; widget_signing_secret: string };

/** The founder's widget keys (their own account only). */
export async function getWidgetKeys(db: Db, accountId: string): Promise<WidgetKeys> {
  const row = await attempt("Loading widget keys", () =>
    queryOne<WidgetKeys>(db, "select widget_publishable_key, widget_signing_secret from accounts where id = $1", [accountId]),
  );
  if (!row) throw new Error("Loading widget keys failed: account not found");
  return row;
}

/** New signing secret for the founder's own account (e.g. after a leak). True if a row changed. */
export async function rotateWidgetSigningSecret(db: Db, accountId: string): Promise<boolean> {
  const rows = await attempt("Rotating signing secret", () =>
    db.query<{ id: string }>("update accounts set widget_signing_secret = new_widget_signing_secret() where id = $1 returning id", [accountId]),
  );
  return rows.length > 0;
}

/**
 * Saves a completed Stripe Connect OAuth on the founder's account. Throws an
 * error with code 23505 when that Stripe account is already actively
 * connected to another unquit account (accounts_connected_stripe_account_key).
 */
export async function saveStripeConnection(
  db: Db,
  accountId: string,
  f: { stripeAccountId: string; livemode: boolean | null; scope: string | null; at: string },
): Promise<void> {
  await db.query(
    `update accounts
        set stripe_account_id = $2, stripe_connection_status = 'connected', stripe_livemode = $3,
            stripe_scope = $4, stripe_connected_at = $5, stripe_disconnected_at = null
      where id = $1`,
    [accountId, f.stripeAccountId, f.livemode, f.scope, f.at],
  );
}

/** Marks the founder's own account disconnected from Stripe. */
export async function markStripeDisconnected(db: Db, accountId: string, at: string): Promise<void> {
  await attempt("Disconnecting", () =>
    db.query("update accounts set stripe_connection_status = 'disconnected', stripe_disconnected_at = $2 where id = $1", [accountId, at]),
  );
}
