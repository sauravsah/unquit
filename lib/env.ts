/**
 * Typed, lazy access to environment variables.
 *
 * Values are read when a function is called, not when the module is imported,
 * so `npm run build` works without real secrets. A missing variable throws a
 * clear error at request time instead of failing silently.
 */

function required(name: string, value: string | undefined): string {
  if (!value || value.trim() === "") {
    throw new Error(
      `Missing environment variable ${name}. Copy .env.example to .env.local (or set it in Vercel) and fill it in.`,
    );
  }
  return value;
}

// NEXT_PUBLIC_* must be referenced literally so Next.js can inline them into
// browser bundles.
export const publicEnv = {
  appUrl: () =>
    required("NEXT_PUBLIC_APP_URL", process.env.NEXT_PUBLIC_APP_URL).replace(/\/+$/, ""),
  // Unquit's PLATFORM publishable key (pk_test_… / pk_live_…). Stripe Elements
  // on the card-update page uses it with the founder's account id.
  stripePublishableKey: () =>
    required("NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY", process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY),
};

// Server-only secrets. Never import these from a "use client" file.
export const serverEnv = {
  /** Public beta safety switch. It defaults on until a deliberate live launch. */
  betaMode: () => (process.env.UNQUIT_BETA_MODE ?? "true").trim() !== "false",
  // Postgres (Neon). Vercel's Neon integration sets DATABASE_URL (pooled) and
  // POSTGRES_URL; either works for the app. Migrations prefer the unpooled URL.
  databaseUrl: () =>
    required("DATABASE_URL", firstSet(process.env.DATABASE_URL, process.env.POSTGRES_URL, process.env.DATABASE_URL_UNPOOLED)),
  // Auth.js: signs and encrypts the session JWT. `openssl rand -base64 32`.
  // NEXTAUTH_SECRET is accepted as a fallback for older setups.
  authSecret: () => required("AUTH_SECRET", firstSet(process.env.AUTH_SECRET, process.env.NEXTAUTH_SECRET)),
  stripeSecretKey: () => required("STRIPE_SECRET_KEY", process.env.STRIPE_SECRET_KEY),
  stripeConnectClientId: () => required("STRIPE_CONNECT_CLIENT_ID", process.env.STRIPE_CONNECT_CLIENT_ID),
  stripeWebhookSecret: () => required("STRIPE_WEBHOOK_SECRET", process.env.STRIPE_WEBHOOK_SECRET),
  resendApiKey: () => process.env.RESEND_API_KEY ?? "",
  // The address dunning emails are sent from, on a domain verified in Resend,
  // e.g. billing@mail.yourdomain.com. The founder's company name is the display name.
  emailFromAddress: () => (process.env.EMAIL_FROM_ADDRESS ?? "").trim(),
  // Vercel Cron sends "Authorization: Bearer <CRON_SECRET>" to /api/cron/dunning.
  cronSecret: () => required("CRON_SECRET", process.env.CRON_SECRET),
  // Signs the card-update links in dunning emails. 32+ random characters.
  dunningLinkSecret: () => required("DUNNING_LINK_SECRET", process.env.DUNNING_LINK_SECRET),
  // Week 4. Comma-separated sign-in emails allowed into /admin (the dispute review queue).
  adminEmails: () => parseEmailList(process.env.ADMIN_EMAILS),
  // Signing secret of the SECOND Stripe webhook endpoint ("Events on your account"),
  // for unquit's own invoices and Checkout. Optional: billing works without it,
  // the billing page just refreshes invoice status from Stripe instead.
  stripePlatformWebhookSecret: () => (process.env.STRIPE_PLATFORM_WEBHOOK_SECRET ?? "").trim(),
  // 32 random bytes (base64 or hex) that encrypt founders' Stripe restricted keys and
  // webhook secrets at rest (AES-256-GCM). `openssl rand -base64 32`. Restricted-key
  // connections fail closed without it; changing it makes stored keys unreadable.
  stripeKeyEncryptionKey: () => required("STRIPE_KEY_ENCRYPTION_KEY", process.env.STRIPE_KEY_ENCRYPTION_KEY),
  // Dodo Payments (merchant of record for unquit's OWN fees): API key, the
  // signing secret of the webhook endpoint /api/billing/dodo/webhook (whsec_…),
  // test_mode or live_mode, and the "Unquit usage fees" subscription product.
  dodoApiKey: () => required("DODO_PAYMENTS_API_KEY", process.env.DODO_PAYMENTS_API_KEY),
  dodoWebhookSecret: () => required("DODO_PAYMENTS_WEBHOOK_SECRET", process.env.DODO_PAYMENTS_WEBHOOK_SECRET),
  dodoEnvironment: (): "test_mode" | "live_mode" => {
    const v = (process.env.DODO_PAYMENTS_ENVIRONMENT ?? "test_mode").trim();
    if (v !== "test_mode" && v !== "live_mode") throw new Error(`DODO_PAYMENTS_ENVIRONMENT must be test_mode or live_mode, got "${v}"`);
    if (serverEnv.betaMode() && v === "live_mode") throw new Error("DODO_PAYMENTS_ENVIRONMENT must be test_mode during the public beta.");
    return v;
  },
  dodoUsageProductId: () => required("DODO_USAGE_PRODUCT_ID", process.env.DODO_USAGE_PRODUCT_ID),
  // Days a pending cancel save waits for its first paid invoice (default 45).
  verifyWindowDays: () => process.env.VERIFY_WINDOW_DAYS,
};

/** Rejects live financial credentials while the public test beta is enabled. */
export function assertTestMode(kind: string, value: string, beta = serverEnv.betaMode()): string {
  if (beta && /^(?:sk|pk|rk)_live_/.test(value.trim())) throw new Error(`${kind} must use a Stripe test-mode credential during the public beta.`);
  return value;
}

/** The first non-empty value. */
export function firstSet(...values: (string | undefined)[]): string | undefined {
  return values.find((v) => v !== undefined && v.trim() !== "");
}

/** "a@x.com, B@y.com" -> ["a@x.com", "b@y.com"]. */
export function parseEmailList(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(/[,;\s]+/)
    .map((e) => e.trim().toLowerCase())
    .filter((e) => e.includes("@"));
}

/** True when this signed-in email is listed in ADMIN_EMAILS. */
export function isAdminEmail(email: string | null | undefined, admins: readonly string[] = serverEnv.adminEmails()): boolean {
  if (!email) return false;
  return admins.includes(email.trim().toLowerCase());
}
