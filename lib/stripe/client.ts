import "server-only";
import Stripe from "stripe";
import type { Db } from "@/lib/db/core";
import { assertTestMode, serverEnv } from "@/lib/env";
import { createStripeResolver, type StripeResolver } from "./connection";

let cached: Stripe | null = null;

const APP_INFO = { name: "unquit", url: "https://github.com/sauravsah/unquit" };

/**
 * Stripe client for Unquit's PLATFORM account (Unquit's own billing, OAuth,
 * and Stripe Connect calls with `{ stripeAccount }`).
 *
 * To act on a FOUNDER'S account use getStripeResolver(db): it picks Connect
 * (platform key + Stripe-Account header) or the founder's own restricted key.
 */
export function getStripe(): Stripe {
  if (!cached) {
    cached = new Stripe(assertTestMode("STRIPE_SECRET_KEY", serverEnv.stripeSecretKey()), { appInfo: APP_INFO, maxNetworkRetries: 2 });
  }
  return cached;
}

/** A client for a founder's restricted key (key mode). */
export function createStripeClient(apiKey: string): Stripe {
  return new Stripe(assertTestMode("Stripe restricted key", apiKey), { appInfo: APP_INFO, maxNetworkRetries: 2 });
}

/** Resolves the right client + request options for any founder's Stripe account id. */
export function getStripeResolver(db: Db): StripeResolver {
  return createStripeResolver(db, {
    platform: getStripe,
    clientForKey: createStripeClient,
    encryptionKey: () => process.env.STRIPE_KEY_ENCRYPTION_KEY,
  });
}
