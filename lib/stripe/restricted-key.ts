import type Stripe from "stripe";

/**
 * Restricted-key connections: a founder pastes a Stripe restricted key
 * (rk_live_… / rk_test_…) instead of approving Stripe Connect.
 *
 * REQUIRED_PERMISSIONS is derived from every Stripe call Unquit makes on a
 * founder's account (lib/widget/stripe-ops.ts, lib/dunning/stripe-ops.ts,
 * lib/ledger/stripe-ops.ts, app/dashboard/flows, and the webhook endpoint this
 * mode creates). Permission ids follow https://docs.stripe.com/keys/permissions-reference
 * (Stripe's errors name them as "rak_<id>"). "Write" includes "Read" in Stripe.
 *
 * Every probe is safe: a read probe lists at most one object, and a write probe
 * UPDATES AN ID THAT CANNOT EXIST with no fields. With the permission Stripe
 * answers 404 (resource_missing); without it, 403. Nothing is ever changed.
 */

export type PermissionId =
  | "customer_write"
  | "subscription_write"
  | "invoice_write"
  | "coupon_write"
  | "setup_intent_write"
  | "payment_intent_read"
  | "charge_read"
  | "plan_read"
  | "product_read"
  | "webhook_write";

export type Permission = {
  id: PermissionId;
  /** Where it sits in Stripe's "Create restricted key" form. */
  section: "Core" | "Billing" | "Webhook";
  resource: string;
  level: "Read" | "Write";
  why: string;
  probe: (stripe: Stripe) => Promise<unknown>;
};

// Ids that cannot exist on any account (Stripe ids never contain "unquit_probe").
const PROBE = "unquit_probe_does_not_exist";

export const REQUIRED_PERMISSIONS: readonly Permission[] = [
  {
    id: "customer_write",
    section: "Core",
    resource: "Customers",
    level: "Write",
    why: "Make the card your customer adds on the card-update page their default (customers.update).",
    probe: (s) => s.customers.update(`cus_${PROBE}`, {}),
  },
  {
    id: "setup_intent_write",
    section: "Core",
    resource: "SetupIntents",
    level: "Write",
    why: "Collect a new card securely on the card-update page (setupIntents.create / retrieve).",
    probe: (s) => s.setupIntents.update(`seti_${PROBE}`, {}),
  },
  {
    id: "payment_intent_read",
    section: "Core",
    resource: "PaymentIntents",
    level: "Read",
    why: "Read why a renewal failed (the decline code) and finish 3-D Secure checks.",
    probe: (s) => s.paymentIntents.list({ limit: 1 }),
  },
  {
    id: "charge_read",
    section: "Core",
    resource: "Charges and Refunds",
    level: "Read",
    why: "Match a refund to its invoice so Unquit’s fee on it is clawed back.",
    probe: (s) => s.charges.list({ limit: 1 }),
  },
  {
    id: "product_read",
    section: "Core",
    resource: "Products",
    level: "Read",
    why: "Show plan names in the cancel-flow editor and downgrade offers.",
    probe: (s) => s.products.list({ limit: 1 }),
  },
  {
    id: "subscription_write",
    section: "Billing",
    resource: "Subscriptions",
    level: "Write",
    why: "Read subscriptions; apply a discount, pause or downgrade the customer accepted; cancel when they choose to.",
    probe: (s) => s.subscriptions.update(`sub_${PROBE}`, {}),
  },
  {
    id: "invoice_write",
    section: "Billing",
    resource: "Invoices",
    level: "Write",
    why: "Read invoices and invoice payments (to prove saves); pay a failed invoice from the card-update page (invoices.pay).",
    probe: (s) => s.invoices.update(`in_${PROBE}`, {}),
  },
  {
    id: "coupon_write",
    section: "Billing",
    resource: "Coupons",
    level: "Write",
    why: "Create the reusable coupon behind a discount offer, e.g. “30% off for 3 months”.",
    probe: (s) => s.coupons.update(PROBE, {}),
  },
  {
    id: "plan_read",
    section: "Billing",
    resource: "Prices",
    level: "Read",
    why: "List your prices for downgrade offers.",
    probe: (s) => s.prices.list({ limit: 1 }),
  },
  {
    id: "webhook_write",
    section: "Webhook",
    resource: "Webhook Endpoints",
    level: "Write",
    why: "Create (and on disconnect, delete) the one webhook endpoint that tells Unquit about renewals, failures and refunds.",
    probe: (s) => s.webhookEndpoints.update(`we_${PROBE}`, {}),
  },
];

/**
 * Optional: Connect → Accounts: Read lets Unquit read your account id directly
 * (GET /v1/account). Without it Unquit reads the id from Stripe's permission
 * error instead, so it isn't required.
 */
export const OPTIONAL_ACCOUNT_PERMISSION = {
  id: "connected_account_read",
  section: "Connect",
  resource: "Accounts",
  level: "Read",
  why: "Read your Stripe account id (acct_…). Optional.",
} as const;

/** Events the restricted-key webhook endpoint subscribes to: the Connect webhook's events minus the Connect-only one. */
export const KEY_MODE_WEBHOOK_EVENTS = [
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "invoice.payment_failed",
  "invoice.paid",
  "charge.refunded",
  "credit_note.created",
  "credit_note.updated",
  "credit_note.voided",
  "charge.dispute.created",
  "charge.dispute.updated",
  "charge.dispute.closed",
] as const;

export type KeyKind =
  | { kind: "restricted"; livemode: boolean }
  | { kind: "secret" }
  | { kind: "publishable" }
  | { kind: "invalid" };

export function classifyKey(raw: string): KeyKind {
  const key = raw.trim();
  const m = /^rk_(live|test)_[A-Za-z0-9]{10,}$/.exec(key);
  if (m) return { kind: "restricted", livemode: m[1] === "live" };
  if (/^sk_(live|test)_/.test(key)) return { kind: "secret" };
  if (/^pk_(live|test)_/.test(key)) return { kind: "publishable" };
  return { kind: "invalid" };
}

export function publishableKeyMode(raw: string): "live" | "test" | null {
  const m = /^pk_(live|test)_[A-Za-z0-9]{10,}$/.exec(raw.trim());
  return m ? (m[1] as "live" | "test") : null;
}

export class KeyValidationError extends Error {
  constructor(
    public readonly code:
      | "not_restricted"
      | "secret_key"
      | "publishable_key"
      | "publishable_missing"
      | "publishable_mismatch"
      | "invalid_key"
      | "missing_permissions"
      | "account_unknown"
      | "stripe_unreachable",
    message: string,
    public readonly missing: readonly Permission[] = [],
  ) {
    super(message);
  }
}

type StripeErrorLike = { statusCode?: number; type?: string; code?: string; message?: string; raw?: { message?: string } };

function statusOf(error: unknown): number | undefined {
  const e = error as StripeErrorLike | null;
  if (e?.type === "StripePermissionError") return 403;
  if (e?.type === "StripeAuthenticationError") return 401;
  return e?.statusCode;
}

const ACCT_IN_MESSAGE = /on account '(acct_[A-Za-z0-9]+)'/;

/** Runs one probe: "ok" (allowed), "denied" (403). Throws for a bad key or an unreachable Stripe. */
async function probe(run: () => Promise<unknown>): Promise<{ result: "ok" | "denied"; message?: string }> {
  try {
    await run();
    return { result: "ok" };
  } catch (error) {
    const status = statusOf(error);
    const message = (error as StripeErrorLike).message ?? (error as StripeErrorLike).raw?.message;
    if (status === 403) return { result: "denied", message };
    if (status === 401) throw new KeyValidationError("invalid_key", "Stripe didn’t accept this key. Check you copied all of it, and that it hasn’t been deleted or expired.");
    // 404 / 400 on a probe id: the call was authorised, the object just doesn't exist.
    if (status !== undefined && status >= 400 && status < 500) return { result: "ok" };
    throw new KeyValidationError("stripe_unreachable", "We couldn’t reach Stripe to check the key. Please try again in a minute.");
  }
}

export type ValidatedKey = {
  accountId: string;
  livemode: boolean;
  keyLast4: string;
};

/** Shape-only check (no network): throws for sk_, pk_ or anything that isn't rk_live_/rk_test_. Returns livemode. */
export function assertRestrictedShape(rawKey: string): boolean {
  const kind = classifyKey(rawKey);
  if (kind.kind === "restricted") return kind.livemode;
  if (kind.kind === "secret") {
    throw new KeyValidationError(
      "secret_key",
      "That’s a secret key (sk_…), which can do anything in your Stripe account. Please create a restricted key (rk_…) with only the permissions listed instead, and don’t share the secret key.",
    );
  }
  if (kind.kind === "publishable") {
    throw new KeyValidationError("publishable_key", "That’s a publishable key (pk_…). Paste it in the publishable key box, and the restricted key (rk_…) in the restricted key box.");
  }
  throw new KeyValidationError("not_restricted", "That doesn’t look like a Stripe restricted key. It should start with rk_live_ or rk_test_.");
}

/**
 * Checks a pasted restricted key: shape, that Stripe accepts it, that every
 * required permission is granted, and which Stripe account it belongs to.
 * `stripe` must be a client built with that key.
 */
export async function validateRestrictedKey(rawKey: string, stripe: Stripe): Promise<ValidatedKey> {
  const key = rawKey.trim();
  const livemode = assertRestrictedShape(key);

  // 1. The test call: who does this key belong to? (Also catches a revoked or mistyped key.)
  let accountId = null as string | null;
  const who = await probe(async () => {
    const acct = await stripe.accounts.retrieveCurrent();
    accountId = acct.id;
  });
  if (who.result === "denied") accountId = who.message?.match(ACCT_IN_MESSAGE)?.[1] ?? null;

  // 2. Every required permission, in parallel.
  const results = await Promise.all(REQUIRED_PERMISSIONS.map(async (p) => ({ p, r: await probe(() => p.probe(stripe)) })));
  const missing = results.filter((x) => x.r.result === "denied").map((x) => x.p);
  if (!accountId) accountId = results.map((x) => x.r.message?.match(ACCT_IN_MESSAGE)?.[1]).find(Boolean) ?? null;
  if (missing.length) {
    const names = missing.map((p) => `${p.resource}: ${p.level}`).join(", ");
    throw new KeyValidationError(
      "missing_permissions",
      `This key is missing ${missing.length === 1 ? "a permission" : `${missing.length} permissions`}: ${names}. Edit the key in Stripe (Developers → API keys → ⋯ → Edit key), add ${missing.length === 1 ? "it" : "them"}, save, and paste it again.`,
      missing,
    );
  }
  if (!accountId) {
    throw new KeyValidationError(
      "account_unknown",
      "We couldn’t tell which Stripe account this key belongs to. Add Connect → Accounts: Read to the key and try again.",
    );
  }
  return { accountId, livemode, keyLast4: key.slice(-4) };
}

/** Checks the publishable key is present and in the same mode (live/test) as the restricted key. */
export function checkPublishableKey(rawPk: string | null | undefined, livemode: boolean): string {
  const pk = (rawPk ?? "").trim();
  if (!pk) {
    throw new KeyValidationError("publishable_missing", "Paste your publishable key (pk_…) too. Your customers’ card-update page needs it to show Stripe’s secure card form.");
  }
  if (/^(sk|rk)_/.test(pk)) {
    throw new KeyValidationError("publishable_key", "The publishable key box needs the key that starts with pk_. Never paste a secret key there.");
  }
  const mode = publishableKeyMode(pk);
  if (!mode) throw new KeyValidationError("publishable_key", "That doesn’t look like a Stripe publishable key. It should start with pk_live_ or pk_test_.");
  if ((mode === "live") !== livemode) {
    throw new KeyValidationError(
      "publishable_mismatch",
      `The restricted key is a ${livemode ? "live" : "test"}-mode key but the publishable key is ${mode} mode. Use both keys from the same mode.`,
    );
  }
  return pk;
}

/**
 * Confirms the publishable key belongs to the SAME Stripe account: a SetupIntent
 * made with the restricted key can only be read back with that account's
 * publishable key. The SetupIntent is cancelled straight away (no card, no charge).
 */
export async function verifyPublishableKeyMatches(
  stripe: Stripe,
  publishableKey: string,
  readWithPublishable: (publishableKey: string, setupIntentId: string, clientSecret: string) => Promise<boolean>,
): Promise<void> {
  const si = await stripe.setupIntents.create({ usage: "off_session", allowed_payment_method_types: ["card"], metadata: { unquit_key_check: "1" } });
  try {
    const ok = si.client_secret ? await readWithPublishable(publishableKey, si.id, si.client_secret) : false;
    if (!ok) {
      throw new KeyValidationError(
        "publishable_mismatch",
        "The publishable key is from a different Stripe account than the restricted key. Copy both from the same account (Developers → API keys).",
      );
    }
  } finally {
    await stripe.setupIntents.cancel(si.id).catch(() => undefined);
  }
}

/** Real check of a publishable key against a SetupIntent (what Stripe.js does in the browser). */
export async function readSetupIntentWithPublishableKey(publishableKey: string, setupIntentId: string, clientSecret: string): Promise<boolean> {
  const url = `https://api.stripe.com/v1/setup_intents/${encodeURIComponent(setupIntentId)}?client_secret=${encodeURIComponent(clientSecret)}`;
  const res = await fetch(url, { headers: { authorization: `Bearer ${publishableKey}` } });
  return res.ok;
}
