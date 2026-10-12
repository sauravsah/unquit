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
  supabaseUrl: () => required("NEXT_PUBLIC_SUPABASE_URL", process.env.NEXT_PUBLIC_SUPABASE_URL),
  supabaseAnonKey: () => required("NEXT_PUBLIC_SUPABASE_ANON_KEY", process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY),
  appUrl: () =>
    required("NEXT_PUBLIC_APP_URL", process.env.NEXT_PUBLIC_APP_URL).replace(/\/+$/, ""),
  // Unquit's PLATFORM publishable key (pk_test_… / pk_live_…). Stripe Elements
  // on the card-update page uses it with the founder's account id.
  stripePublishableKey: () =>
    required("NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY", process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY),
};

// Server-only secrets. Never import these from a "use client" file.
export const serverEnv = {
  supabaseServiceRoleKey: () => required("SUPABASE_SERVICE_ROLE_KEY", process.env.SUPABASE_SERVICE_ROLE_KEY),
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
  // Days a pending cancel save waits for its first paid invoice (default 45).
  verifyWindowDays: () => process.env.VERIFY_WINDOW_DAYS,
};

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
