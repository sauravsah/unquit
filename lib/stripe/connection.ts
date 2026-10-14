import type Stripe from "stripe";
import { attempt, queryOne, type Db } from "@/lib/db/core";
import { decryptSecret, encryptSecret, parseEncryptionKey } from "./key-crypto";

/**
 * How Unquit talks to ONE founder's Stripe account, whichever way it's connected:
 *
 *   connect  Stripe Connect (OAuth): Unquit's platform key + `Stripe-Account: acct_…`
 *   key      a restricted key the founder pasted: a client built with THEIR key,
 *            no Stripe-Account header (the key already belongs to their account)
 *
 * Every call on a founder's account goes through a StripeTarget:
 *   const { stripe, on } = await resolve(stripeAccountId);
 *   await stripe.invoices.retrieve(id, {}, on);
 *   await stripe.subscriptions.update(id, params, { ...on, idempotencyKey });
 */
export type ConnectionMode = "connect" | "key";

export type StripeTarget = {
  stripe: Stripe;
  /** Request options for every call: `{ stripeAccount }` in connect mode, `{}` in key mode. */
  on: Stripe.RequestOptions;
  mode: ConnectionMode;
  stripeAccountId: string;
  /** The founder's own publishable key (key mode), for Stripe Elements; null means use the platform's. */
  publishableKey: string | null;
};

export type StripeResolver = (stripeAccountId: string) => Promise<StripeTarget>;

export function connectTarget(platform: Stripe, stripeAccountId: string): StripeTarget {
  return { stripe: platform, on: { stripeAccount: stripeAccountId }, mode: "connect", stripeAccountId, publishableKey: null };
}

export function keyTarget(client: Stripe, stripeAccountId: string, publishableKey: string | null): StripeTarget {
  return { stripe: client, on: {}, mode: "key", stripeAccountId, publishableKey };
}

/** The accounts columns a resolver needs. */
export type ConnectionRow = {
  id: string;
  stripe_account_id: string;
  stripe_connection_mode: ConnectionMode;
  stripe_key_ciphertext: string | null;
  stripe_publishable_key: string | null;
};

export type ResolverDeps = {
  platform: () => Stripe;
  /** Builds a Stripe client for a founder's restricted key. */
  clientForKey: (key: string) => Stripe;
  /** STRIPE_KEY_ENCRYPTION_KEY (raw env value); read lazily so connect mode never needs it. */
  encryptionKey: () => string | undefined;
};

export class ConnectionError extends Error {}

/** Pure: the target for one account row. Key mode decrypts the stored key (fails closed). */
export function targetForRow(row: ConnectionRow | null, stripeAccountId: string, deps: ResolverDeps): StripeTarget {
  if (!row || row.stripe_connection_mode !== "key") return connectTarget(deps.platform(), stripeAccountId);
  if (!row.stripe_key_ciphertext) throw new ConnectionError(`Stripe key for ${stripeAccountId} is missing; reconnect Stripe`);
  const key = decryptSecret(row.stripe_key_ciphertext, parseEncryptionKey(deps.encryptionKey()), row.id);
  return keyTarget(deps.clientForKey(key), stripeAccountId, row.stripe_publishable_key);
}

const CONNECTION_COLUMNS = "id, stripe_account_id, stripe_connection_mode, stripe_key_ciphertext, stripe_publishable_key";

/** The connected account row for a Stripe account id (the connected one wins over old disconnected rows). */
export async function loadConnectionRow(db: Db, stripeAccountId: string): Promise<ConnectionRow | null> {
  return attempt("Loading Stripe connection", () =>
    queryOne<ConnectionRow>(
      db,
      `select ${CONNECTION_COLUMNS} from accounts
        where stripe_account_id = $1
        order by (stripe_connection_status = 'connected') desc, stripe_connected_at desc nulls last
        limit 1`,
      [stripeAccountId],
    ),
  );
}

/**
 * A resolver backed by the accounts table. Caches per instance (one request or
 * one cron run), so a batch of calls on one account decrypts its key once.
 */
export function createStripeResolver(db: Db, deps: ResolverDeps): StripeResolver {
  const cache = new Map<string, Promise<StripeTarget>>();
  return (stripeAccountId) => {
    let hit = cache.get(stripeAccountId);
    if (!hit) {
      hit = loadConnectionRow(db, stripeAccountId).then((row) => targetForRow(row, stripeAccountId, deps));
      hit.catch(() => cache.delete(stripeAccountId));
      cache.set(stripeAccountId, hit);
    }
    return hit;
  };
}

/** Encrypts a secret for one account row (the row id is bound in as AAD). */
export function sealForAccount(secret: string, accountId: string, rawEncryptionKey: string | undefined): string {
  return encryptSecret(secret, parseEncryptionKey(rawEncryptionKey), accountId);
}

export function openForAccount(ciphertext: string, accountId: string, rawEncryptionKey: string | undefined): string {
  return decryptSecret(ciphertext, parseEncryptionKey(rawEncryptionKey), accountId);
}
