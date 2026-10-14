import Stripe from "stripe";
import { decryptSecret, encryptSecret, parseEncryptionKey } from "./key-crypto";
import {
  KEY_MODE_WEBHOOK_EVENTS,
  KeyValidationError,
  assertRestrictedShape,
  checkPublishableKey,
  validateRestrictedKey,
  verifyPublishableKeyMatches,
} from "./restricted-key";

/**
 * Connecting and disconnecting a founder's Stripe account with a restricted key.
 * Pure orchestration over injected dependencies, so tests run it against fakes.
 *
 * Connect: validate the key (shape, test call, every permission, which account),
 * check the publishable key belongs to the same account, create a webhook
 * endpoint on THEIR account pointing at /api/stripe/webhook/acct/<account id>,
 * then store the key and the endpoint's signing secret encrypted.
 *
 * Disconnect: delete that webhook endpoint with their key, then wipe both secrets.
 */

export type KeyConnectRepo = {
  connectedElsewhere(stripeAccountId: string, accountId: string): Promise<boolean>;
  loadSecrets(accountId: string): Promise<{
    stripe_connection_mode: "connect" | "key";
    stripe_key_ciphertext: string | null;
    stripe_webhook_endpoint_id: string | null;
  } | null>;
  save(accountId: string, c: {
    stripeAccountId: string;
    livemode: boolean;
    keyCiphertext: string;
    keyLast4: string;
    publishableKey: string;
    webhookEndpointId: string;
    webhookSecretCiphertext: string;
    at: string;
  }): Promise<void>;
  clear(accountId: string, at: string): Promise<void>;
};

export type KeyConnectDeps = {
  repo: KeyConnectRepo;
  clientForKey: (key: string) => Stripe;
  /** Raw STRIPE_KEY_ENCRYPTION_KEY. */
  encryptionKey: () => string | undefined;
  appUrl: string;
  readWithPublishable: (publishableKey: string, setupIntentId: string, clientSecret: string) => Promise<boolean>;
  now?: () => Date;
  log?: (line: string) => void;
};

export class KeyConnectError extends Error {
  constructor(
    public readonly code: "not_configured" | "already_connected_elsewhere" | "webhook_failed" | "save_failed",
    message: string,
  ) {
    super(message);
  }
}

export function directWebhookUrl(appUrl: string, accountId: string): string {
  return `${appUrl.replace(/\/+$/, "")}/api/stripe/webhook/acct/${encodeURIComponent(accountId)}`;
}

function isUniqueViolation(error: unknown): boolean {
  return (error as { code?: string } | null)?.code === "23505";
}

function isMissing(error: unknown): boolean {
  const e = error as { statusCode?: number; code?: string } | null;
  return e?.statusCode === 404 || e?.code === "resource_missing";
}

export async function connectWithRestrictedKey(
  deps: KeyConnectDeps,
  input: { accountId: string; restrictedKey: string; publishableKey: string | null | undefined },
): Promise<{ stripeAccountId: string; livemode: boolean; keyLast4: string }> {
  // Fail closed BEFORE touching Stripe: no encryption key, no connection.
  let encKey: Buffer;
  try {
    encKey = parseEncryptionKey(deps.encryptionKey());
  } catch {
    throw new KeyConnectError("not_configured", "Restricted-key connections aren’t switched on for this Unquit server yet (STRIPE_KEY_ENCRYPTION_KEY is missing). Please use Connect with Stripe, or try again later.");
  }

  const rk = input.restrictedKey.trim();
  // Shape errors first (sk_, pk_, junk) without any network call.
  const livemode = assertRestrictedShape(rk);
  const pk = checkPublishableKey(input.publishableKey, livemode);

  const client = deps.clientForKey(rk);
  const validated = await validateRestrictedKey(rk, client);
  await verifyPublishableKeyMatches(client, pk, deps.readWithPublishable);

  if (await deps.repo.connectedElsewhere(validated.accountId, input.accountId)) {
    throw new KeyConnectError("already_connected_elsewhere", "That Stripe account is already connected to another Unquit login.");
  }

  // Reconnecting (e.g. rotating the key): remove the endpoint the old key created.
  const previous = await deps.repo.loadSecrets(input.accountId);
  if (previous?.stripe_connection_mode === "key" && previous.stripe_webhook_endpoint_id) {
    await deleteEndpoint(deps, encKey, input.accountId, previous.stripe_key_ciphertext, previous.stripe_webhook_endpoint_id, client);
  }

  let endpoint: Stripe.WebhookEndpoint;
  try {
    endpoint = await client.webhookEndpoints.create({
      url: directWebhookUrl(deps.appUrl, input.accountId),
      enabled_events: [...KEY_MODE_WEBHOOK_EVENTS],
      api_version: Stripe.API_VERSION,
      description: "Unquit churn recovery (created automatically; deleted when you disconnect Unquit)",
      metadata: { created_by: "unquit", unquit_account: input.accountId },
    });
  } catch (error) {
    deps.log?.(`[stripe/key] webhook endpoint create failed: ${error instanceof Error ? error.message : String(error)}`);
    throw new KeyConnectError("webhook_failed", "Stripe didn’t let us create the webhook endpoint. Check the key has Webhook Endpoints: Write and try again.");
  }
  if (!endpoint.secret) {
    await client.webhookEndpoints.del(endpoint.id).catch(() => undefined);
    throw new KeyConnectError("webhook_failed", "Stripe created the webhook endpoint without a signing secret. Please try again.");
  }

  try {
    await deps.repo.save(input.accountId, {
      stripeAccountId: validated.accountId,
      livemode: validated.livemode,
      keyCiphertext: encryptSecret(rk, encKey, input.accountId),
      keyLast4: validated.keyLast4,
      publishableKey: pk,
      webhookEndpointId: endpoint.id,
      webhookSecretCiphertext: encryptSecret(endpoint.secret, encKey, input.accountId),
      at: (deps.now?.() ?? new Date()).toISOString(),
    });
  } catch (error) {
    await client.webhookEndpoints.del(endpoint.id).catch(() => undefined);
    if (isUniqueViolation(error)) {
      throw new KeyConnectError("already_connected_elsewhere", "That Stripe account is already connected to another Unquit login.");
    }
    throw new KeyConnectError("save_failed", "We couldn’t save your Stripe connection. Please try again.");
  }
  return { stripeAccountId: validated.accountId, livemode: validated.livemode, keyLast4: validated.keyLast4 };
}

async function deleteEndpoint(
  deps: Pick<KeyConnectDeps, "clientForKey" | "log">,
  encKey: Buffer,
  accountId: string,
  keyCiphertext: string | null,
  endpointId: string,
  fallback?: Stripe,
): Promise<boolean> {
  let client = fallback;
  if (keyCiphertext) {
    try {
      client = deps.clientForKey(decryptSecret(keyCiphertext, encKey, accountId));
    } catch {
      deps.log?.(`[stripe/key] stored key for ${accountId} could not be decrypted; endpoint ${endpointId} left for the founder to delete`);
    }
  }
  if (!client) return false;
  try {
    await client.webhookEndpoints.del(endpointId);
    return true;
  } catch (error) {
    if (isMissing(error)) return true; // already gone
    deps.log?.(`[stripe/key] deleting webhook endpoint ${endpointId} failed: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}

/**
 * Disconnects a key-mode account: deletes Unquit's webhook endpoint on their
 * Stripe account (best effort: a revoked key can't, and that's fine), then wipes
 * the stored key, publishable key and signing secret. Never throws on the
 * Stripe side, so the founder can always disconnect.
 */
export async function disconnectRestrictedKey(
  deps: Pick<KeyConnectDeps, "repo" | "clientForKey" | "encryptionKey" | "now" | "log">,
  accountId: string,
): Promise<{ webhookDeleted: boolean }> {
  const secrets = await deps.repo.loadSecrets(accountId);
  let webhookDeleted = false;
  if (secrets?.stripe_webhook_endpoint_id) {
    let encKey: Buffer | null = null;
    try {
      encKey = parseEncryptionKey(deps.encryptionKey());
    } catch {
      deps.log?.("[stripe/key] STRIPE_KEY_ENCRYPTION_KEY missing: cannot delete the webhook endpoint, wiping the stored key anyway");
    }
    if (encKey) {
      webhookDeleted = await deleteEndpoint(deps, encKey, accountId, secrets.stripe_key_ciphertext, secrets.stripe_webhook_endpoint_id);
    }
  }
  await deps.repo.clear(accountId, (deps.now?.() ?? new Date()).toISOString());
  return { webhookDeleted };
}

export { KeyValidationError };
