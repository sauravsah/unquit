import "server-only";
import type { Db } from "@/lib/db/core";
import {
  clearKeyConnection,
  loadKeyConnectionSecrets,
  saveKeyConnection,
  stripeAccountConnectedElsewhere,
} from "@/lib/accounts";
import { publicEnv } from "@/lib/env";
import { createStripeClient } from "./client";
import type { KeyConnectDeps } from "./key-connect";
import { readSetupIntentWithPublishableKey } from "./restricted-key";

/** Real dependencies for connecting / disconnecting with a restricted key. */
export function keyConnectDeps(db: Db): KeyConnectDeps {
  return {
    repo: {
      connectedElsewhere: (stripeAccountId, accountId) => stripeAccountConnectedElsewhere(db, stripeAccountId, accountId),
      loadSecrets: (accountId) => loadKeyConnectionSecrets(db, accountId),
      save: (accountId, c) => saveKeyConnection(db, accountId, c),
      clear: (accountId, at) => clearKeyConnection(db, accountId, at),
    },
    clientForKey: createStripeClient,
    encryptionKey: () => process.env.STRIPE_KEY_ENCRYPTION_KEY,
    appUrl: publicEnv.appUrl(),
    readWithPublishable: readSetupIntentWithPublishableKey,
    log: (line) => console.warn(line),
  };
}
