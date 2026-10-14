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
  /** 'connect' (Stripe Connect OAuth) or 'key' (a pasted restricted key). */
  stripe_connection_mode: "connect" | "key";
  /** Key mode: the last 4 characters of the restricted key, the only part ever shown. */
  stripe_key_last4: string | null;
  created_at: string;
};

/** The signed-in founder, as the session knows them. */
export type AccountOwner = { id: string; email: string | null };

const ACCOUNT_COLUMNS =
  "id, owner_user_id, name, stripe_account_id, stripe_connection_status, stripe_livemode, stripe_connected_at, stripe_connection_mode, stripe_key_last4, created_at";
// Never add the *_ciphertext columns here: Account objects reach page props.

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
            stripe_scope = $4, stripe_connected_at = $5, stripe_disconnected_at = null,
            stripe_connection_mode = 'connect', stripe_key_ciphertext = null, stripe_key_last4 = null,
            stripe_publishable_key = null, stripe_webhook_endpoint_id = null, stripe_webhook_secret_ciphertext = null
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

// -----------------------------------------------------------------------------
// Restricted-key connections (migration 0008)
// -----------------------------------------------------------------------------

/** Encrypted secrets of a key-mode connection. Server-only: never pass to a page. */
export type KeyConnectionSecrets = {
  id: string;
  stripe_account_id: string | null;
  stripe_connection_status: Account["stripe_connection_status"];
  stripe_connection_mode: "connect" | "key";
  stripe_key_ciphertext: string | null;
  stripe_webhook_endpoint_id: string | null;
  stripe_webhook_secret_ciphertext: string | null;
};

export async function loadKeyConnectionSecrets(db: Db, accountId: string): Promise<KeyConnectionSecrets | null> {
  return attempt("Loading Stripe key connection", () =>
    queryOne<KeyConnectionSecrets>(
      db,
      `select id, stripe_account_id, stripe_connection_status, stripe_connection_mode, stripe_key_ciphertext,
              stripe_webhook_endpoint_id, stripe_webhook_secret_ciphertext
         from accounts where id = $1`,
      [accountId],
    ),
  );
}

/** True when this Stripe account is already actively connected to ANOTHER Unquit account. */
export async function stripeAccountConnectedElsewhere(db: Db, stripeAccountId: string, accountId: string): Promise<boolean> {
  const row = await attempt("Checking Stripe account", () =>
    queryOne<{ id: string }>(
      db,
      "select id from accounts where stripe_account_id = $1 and stripe_connection_status = 'connected' and id <> $2 limit 1",
      [stripeAccountId, accountId],
    ),
  );
  return !!row;
}

export type KeyConnection = {
  stripeAccountId: string;
  livemode: boolean;
  keyCiphertext: string;
  keyLast4: string;
  publishableKey: string;
  webhookEndpointId: string;
  webhookSecretCiphertext: string;
  at: string;
};

/** Saves a validated restricted-key connection. Throws 23505 if the Stripe account is connected elsewhere. */
export async function saveKeyConnection(db: Db, accountId: string, c: KeyConnection): Promise<void> {
  await db.query(
    `update accounts
        set stripe_account_id = $2, stripe_connection_status = 'connected', stripe_connection_mode = 'key',
            stripe_livemode = $3, stripe_scope = null, stripe_connected_at = $4, stripe_disconnected_at = null,
            stripe_key_ciphertext = $5, stripe_key_last4 = $6, stripe_publishable_key = $7,
            stripe_webhook_endpoint_id = $8, stripe_webhook_secret_ciphertext = $9
      where id = $1`,
    [accountId, c.stripeAccountId, c.livemode, c.at, c.keyCiphertext, c.keyLast4, c.publishableKey, c.webhookEndpointId, c.webhookSecretCiphertext],
  );
}

/** Disconnects a key-mode account and wipes every stored key and secret. */
export async function clearKeyConnection(db: Db, accountId: string, at: string): Promise<void> {
  await attempt("Disconnecting", () =>
    db.query(
      `update accounts
          set stripe_connection_status = 'disconnected', stripe_disconnected_at = $2,
              stripe_key_ciphertext = null, stripe_key_last4 = null, stripe_publishable_key = null,
              stripe_webhook_endpoint_id = null, stripe_webhook_secret_ciphertext = null
        where id = $1`,
      [accountId, at],
    ),
  );
}

/** The per-account webhook route's lookup: a CONNECTED key-mode account and its encrypted signing secret. */
export async function loadDirectWebhookAccount(
  db: Db,
  accountId: string,
): Promise<{ id: string; stripe_account_id: string; stripe_webhook_secret_ciphertext: string } | null> {
  return attempt("Loading webhook account", () =>
    queryOne<{ id: string; stripe_account_id: string; stripe_webhook_secret_ciphertext: string }>(
      db,
      `select id, stripe_account_id, stripe_webhook_secret_ciphertext from accounts
        where id = $1 and stripe_connection_mode = 'key' and stripe_connection_status = 'connected'
          and stripe_account_id is not null and stripe_webhook_secret_ciphertext is not null`,
      [accountId],
    ),
  );
}
