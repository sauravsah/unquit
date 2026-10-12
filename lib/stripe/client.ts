import "server-only";
import Stripe from "stripe";
import { serverEnv } from "@/lib/env";

let cached: Stripe | null = null;

/**
 * Stripe client for Unquit's PLATFORM account.
 *
 * To act on a founder's connected account, pass `{ stripeAccount: "acct_..." }`
 * as the request options of any call. The API version is the one pinned by
 * the installed `stripe` package.
 */
export function getStripe(): Stripe {
  if (!cached) {
    cached = new Stripe(serverEnv.stripeSecretKey(), {
      appInfo: { name: "unquit", url: "https://github.com/sauravsah/unquit" },
      maxNetworkRetries: 2,
    });
  }
  return cached;
}
