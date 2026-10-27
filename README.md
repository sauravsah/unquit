# unquit

> **Public beta:** Unquit currently accepts Stripe **test-mode** accounts only. It does not process live customer payments or charge Unquit usage fees. Set `UNQUIT_BETA_MODE=false` only as part of a deliberate live-launch review.

**Unquit your customers. Pay only for the ones we keep.**

Unquit is churn recovery for subscription businesses that bill with **Stripe**.

A founder connects their Stripe account in one click. Unquit then:

1. **Catches cancellations**: a cancel-flow widget shows the right offer (a discount, a pause, or a downgrade) and a short exit survey. *(Week 2, live)*
2. **Recovers failed payments**: a short email sequence matched to why the card failed, and a hosted "update your card" page that pays the invoice on the spot. *(Week 3, live)*
3. **Charges only for proof**: each save gets a receipt (with the Stripe invoice that proved it) and a Dispute button. Refunds and chargebacks claw the fee back automatically. One statement a month, charged automatically to the founder's card through Dodo Payments (merchant of record), capped at $299. *(Week 4, live)*

### Pricing (built into `lib/pricing.ts`)

| | |
|---|---|
| Base fee | **$0** |
| Cancel save | **20% of the saved MRR** for each of the first **3 months** the customer keeps paying |
| Failed-payment save | **10% of the amount recovered** |
| Overlap | If the recovered invoice is also one of a cancel save's 3 paid months, the save fee is charged in full and the recovery fee is **5%** instead of 10% (`OVERLAP_RECOVERY_RATE`, `lib/ledger/overlap.ts`) |
| Monthly cap | **$299** per founder per calendar month, no matter what |
| Refunds | If the customer is refunded (or a credit note is issued), the fee on that invoice is **clawed back pro-rata** |
| Chargebacks | The fee on a disputed invoice is **held**; reversed if the chargeback is lost |
| Rounding | Fees round **down** to the cent; clawbacks round **up** (always in your favour) |

### What counts as a "save"

- **Cancel save**: the customer accepted an offer inside the cancel flow **and** their next invoice was paid (more than $0). Until that invoice is paid, the save stays *pending* and costs nothing. Each of the next two paid invoices on that subscription adds one more month at 20%; after 3 paid months the customer is **free forever**.
- **Dunning save**: a failed invoice that was paid through **Unquit's** retry or Unquit's card-update link. If the money came in some other way (`external`), it isn't billed.
- **Lost**: a pending save is *lost* (never billed) if no qualifying invoice is paid within **45 days** (measured from the end of a pause; change it with `VERIFY_WINDOW_DAYS`), if the customer cancels, or if the customer opens the cancel flow again and accepts a newer offer (the newer save is the one that counts). A verified save whose customer cancels later keeps the months already paid and earns nothing more.

---

## Roadmap

- [x] **Neon + Auth.js** (this release): Postgres on Neon (`DATABASE_URL`), email + password sign-in with Auth.js, tenant isolation in the query layer, `npm run db:migrate`, and a polled live activity feed. Supabase is gone.

- [x] **Week 1: Foundations**
  - Next.js app, database schema with security rules, magic-link sign-in
  - Stripe Connect (connect + disconnect)
  - Stripe webhook: keeps a copy of subscriptions, opens a case for each failed payment, verifies pending saves when an invoice is paid
  - Dashboard shell, landing page, pricing maths with tests
- [x] **Week 2: Cancel-flow widget**
  - `public/widget.js`: a 13 KB (5 KB gzipped), framework-free script founders embed. Opens an accessible modal in a shadow DOM: exit survey, a reason-matched offer (discount, pause or downgrade), accept or "No thanks, cancel", confirmation
  - Public API (`/api/widget/session`, `/accept`, `/cancel`): any origin, authenticated by publishable key + HMAC, rate limited, idempotent
  - Abuse guard: one accepted offer per subscription per 90 days (configurable)
  - Accepting an offer applies it in Stripe and creates a **pending** save; week 1's `invoice.paid` handling verifies it
  - Flow editor at `/dashboard/flows` with 3 templates and a live preview; cancel sessions + widget keys on the dashboard; `/dashboard/test` to try the real widget on a test-mode customer
- [x] **Week 3: Dunning** (this release)
  - Every failed renewal opens a case with Stripe's decline code, sorted into **soft** (e.g. insufficient funds), **hard** (expired, lost, declined) or **needs authentication** (3-D Secure)
  - A 3-email sequence per category, on day 0, 3 and 7 by default (editable per account), sent through **Resend** by a daily **Vercel Cron** job. Soft declines get gentle notes while Stripe Smart Retries do the work; hard and authentication declines go straight to "update your card"
  - The sequence stops the moment the invoice is paid, voided or the subscription is cancelled. Cron runs are idempotent: no customer is ever emailed twice
  - Hosted card-update page at `/u/<link>`: no login, a signed link that expires and dies once a payment succeeds. Stripe Elements on the founder's account, 3-D Secure, the new card becomes the default and the open invoice is paid straight away. "Try my current card again" too
  - Attribution: a payment made on that page (`update_link`) or by unquit's retry after an email click (`unquit_retry`) becomes a dunning save at 10%. Stripe's own recoveries stay `external` and free. Click tracking (and approximate open tracking)
  - **Dashboard → Failed payments**: open cases, emails sent, recoveries and fees, the settings, and an email editor with a live preview
- [x] **Week 4: Ledger, receipts and billing** 
  - The full save lifecycle: fee month 1 on the first paid invoice, months 2 and 3 on the next ones, then free forever. Pending saves become **lost** after 45 days without a paid invoice, when the customer cancels, or when a newer cancel session supersedes them. Cancel sessions left "started" for 24 hours become **abandoned**
  - **Clawbacks**: `charge.refunded` and credit notes reverse the fee on that invoice **pro-rata**; Stripe chargebacks **hold** the fee and reverse it if lost. Re-delivered or overlapping events never count money twice
  - **Receipts** at `/dashboard/saves/UQ-…`: save type, customer, reason and offer (or decline and attribution), the Stripe invoices that proved it, each fee month, clawbacks, a status timeline and **Download PDF**. Founders get a receipt email for every verified save
  - **Disputes**: a "Dispute this save" button holds the fees. Automatic checks of the Stripe invoices settle clear cases in the founder's favour instantly; everything else goes to an admin queue at `/admin` (`ADMIN_EMAILS`). The founder sees the outcome on the receipt and by email
  - **unquit's own billing**: on the 1st, one Stripe Invoice per founder on unquit's platform account for last month (cancel saves + recoveries, $299 cap, credits for later refunds). $0 months get a statement but no invoice. Idempotent per founder and month. **Dashboard → Billing**: running total with a progress bar to the cap, card on file through Stripe Checkout, past statements
  - Overview cards from real data (Saved MRR, Save rate, Recovered, Fees vs cap), ledger filters (type, status, month), every row links to its receipt, **Export CSV**
  - **Automatic charges through Dodo Payments** (migration `0009`, `lib/billing/dodo/`): the founder saves a card once in a Dodo checkout that creates an **on-demand subscription** (`mandate_only: true`) on the "Unquit usage fees" product (`DODO_USAGE_PRODUCT_ID`); "Update card" uses `update-payment-method`. On the 1st (`/api/cron/billing`) each closed statement ≥ $1 gets one `billing_charges` row (unique per statement) and is charged with `POST /subscriptions/{id}/charge` in USD cents; every attempt is claimed in the database before it is sent and at most one can be in flight, so cron retries never double-charge. `/api/billing/dodo/webhook` verifies Standard Webhooks signatures, de-duplicates by `webhook-id`, and settles `payment.succeeded` / `payment.failed` / `refund.succeeded` / `subscription.*`. Failures follow Dodo's safe retry policy (`/api/cron/billing-retries`, daily 06:00 UTC: +3, +10, +17 days anchored to the first attempt, hard declines skipped), then the statement is **unpaid**, the founder sees a banner and gets an email. Product features are **not** paused (open decision, `TODO(billing)` in `lib/billing/dodo/service.ts`). Each account remembers which Dodo environment its card was saved in (`accounts.dodo_environment`, migration `0010`); a card from the other environment (a test-mode card once `DODO_PAYMENTS_ENVIRONMENT=live_mode`) counts as no card, so live never charges test ids. Admin: charges and failures on `/admin`
  - Migration `0004`: founders can read their ledger, receipts, disputes and statements, but only server code changes a fee line, status or billing row

---

## How unquit bills (for founders)

You never pay a base fee. unquit only charges for saves it can prove with a paid Stripe invoice.

- **A customer you kept** (they accepted an offer instead of cancelling): 20% of the monthly revenue you kept, for each of the first **3 months** they actually pay. A $50/month customer costs $10 a month for 3 months, then nothing, ever.
- **A failed payment unquit recovered** (through unquit's card-update link or retry): 10% of the amount, once. Payments Stripe recovers on its own are free.
- **Both on one invoice.** If a customer you saved from cancelling also has a failed payment recovered during their 3 paid months, that invoice pays the 20% save fee plus a reduced 5% recovery fee instead of 10%. Receipts and statements label it "Recovery fee (reduced, overlaps an active save): 5%".
- **Never more than $299** in a calendar month, however many saves there are. The cap is shown on every statement.
- **Refunds come back to you.** If you refund a saved customer (or issue a credit note), the fee on that invoice is reversed in proportion. If the fee was already billed, it's credited on your next statement.
- **Chargebacks are held.** While a customer disputes a payment with their bank, the fee on it isn't billed. If you lose the chargeback, the fee is reversed.
- **Every save has a receipt** (Dashboard → Overview → click a receipt number) showing the Stripe invoice that proved it. If a save shouldn't count, press **Dispute this save**: its fees are held at once. Clear-cut cases (no paid invoice, a refund, the wrong subscription) are reversed automatically; anything else is reviewed by a person and you're emailed the outcome.
- **One automatic charge a month.** Add a billing card once under **Dashboard → Billing** (a Dodo Payments checkout; nothing is charged then). On the 1st, unquit closes last month's statement and charges it to that card through Dodo Payments, unquit's merchant of record (Dodo appears on your card statement). Totals under $1 roll into the next charge; months with nothing to pay get a statement and no charge. A failed charge is retried about 3, 10 and 17 days later (never after a hard decline), and you're emailed to update your card.
- **An unpaid bill pauses Unquit, and paying resumes it.** If a statement is still unpaid after the last retry (or after a hard decline with no new card), you get an email: Unquit will pause in 3 days unless the card is updated. After those 3 days Unquit pauses: your cancel flow shows no offers and no failed-payment emails or retries go out, but your customers can always still cancel, and saves already in progress keep being recorded. You get an email and a dashboard banner ("Update card and resume"). Updating your card charges it straight away, and Unquit resumes automatically the moment the bill is paid (with a "back on" email). (`lib/billing/pause.ts`)

---

## Add the cancel flow to your app (for founders)

You need two things from your Unquit dashboard (**Overview → Widget keys**): the **publishable key** (`pk_…`, safe to put in a web page) and the **signing secret** (`uqsk_…`, server only, like a password).

**1. Add the script** to every page that has a Cancel button (replace the address with your Unquit app's address):

```html
<script src="https://YOUR-UNQUIT-APP.vercel.app/widget.js" data-unquit-key="pk_YOUR_PUBLISHABLE_KEY" defer></script>
```

**2. Sign the customer on your server.** Your backend already knows which Stripe customer and subscription the signed-in user owns. Sign them so nobody can open the cancel flow for someone else's subscription. The signature is HMAC-SHA256 of `customerId:subscriptionId` (with a colon), as lowercase hex:

```js
// Node.js (Express shown; any framework works). Never send the secret to the browser.
import { createHmac } from "node:crypto";

const UNQUIT_SIGNING_SECRET = process.env.UNQUIT_SIGNING_SECRET; // uqsk_...

app.get("/api/unquit-signature", requireLogin, async (req, res) => {
  // Look these up from YOUR database for the logged-in user. Never trust ids sent by the browser.
  const { stripeCustomerId, stripeSubscriptionId } = await getBillingFor(req.user);
  const hmac = createHmac("sha256", UNQUIT_SIGNING_SECRET)
    .update(`${stripeCustomerId}:${stripeSubscriptionId}`)
    .digest("hex");
  res.json({ customerId: stripeCustomerId, subscriptionId: stripeSubscriptionId, hmac });
});
```

**3. Open the flow when the user clicks Cancel:**

```js
document.querySelector("#cancel-button").addEventListener("click", async () => {
  const auth = await fetch("/api/unquit-signature").then((r) => r.json());
  const result = await Unquit.open(auth); // { customerId, subscriptionId, hmac }
  // result.outcome is "saved" (offer accepted), "canceled", "dismissed" (closed, nothing changed),
  // or "unavailable" (Unquit couldn't load: fall back to your own cancel path, never block the customer)
  if (result.outcome === "unavailable") return yourOwnCancel();
  if (result.outcome !== "dismissed") location.reload();
});
```

That's it. Unquit applies the offer or the cancellation directly in your Stripe account. Edit the reasons and offers at **Dashboard → Cancel flow**, and try it end to end at **Dashboard → Test the widget** with a test-mode customer.

- **Offers:** a percentage discount for N months (a Stripe coupon, `duration: repeating`), a pause of 1–3 months (`pause_collection` with `resumes_at`, invoices voided while paused), or a downgrade to a cheaper price (no proration; the lower price applies from the next renewal).
- **Cancelling:** at the end of the paid period by default (`cancel_at_period_end`), or immediately if you choose that in the flow settings. The reason is written to Stripe's `cancellation_details` too.
- **Abuse guard:** a subscription can accept at most one offer every 90 days (change it in the flow settings). After that the customer still sees the survey, then goes straight to the cancel confirmation.
- **Paused accounts and outages (fail-open):** while your Unquit account is paused for an unpaid bill, the widget shows no offers: the survey goes straight to the cancel confirmation and Unquit still cancels the subscription. If the widget can't reach Unquit at all, closing it resolves `Unquit.open()` with `{ outcome: "unavailable" }` so your own cancel path can run.
- **Rotating the secret:** Overview → Widget keys → *Rotate secret*. Signatures made with the old secret stop working immediately, so update your server at the same time.

---

### Connecting with a restricted key (no Stripe Connect needed)

Stripe Connect is invite-only for platforms in some countries (India among them), so founders can also connect by pasting a **restricted key**. On the dashboard, under **Connect with a Stripe restricted key**, the founder follows the steps shown there:

1. Stripe → **Developers → API keys → Create restricted key** (name it *Unquit*).
2. Set exactly these permissions (everything else **None**). They are derived from every Stripe call Unquit makes on a founder's account (`lib/stripe/restricted-key.ts`, `REQUIRED_PERMISSIONS`):

| Section | Resource | Permission | Used for |
|---|---|---|---|
| Core | Customers | Write | make the new card the default after the card-update page |
| Core | SetupIntents | Write | collect a new card on the card-update page |
| Core | PaymentIntents | Read | the decline code behind a failed renewal; 3-D Secure |
| Core | Charges and Refunds | Read | match a refund to its invoice (fee clawbacks) |
| Core | Products | Read | plan names in the flow editor / downgrade offers |
| Billing | Subscriptions | Write | read subscriptions; apply discount / pause / downgrade; cancel |
| Billing | Invoices | Write | read invoices + invoice payments; pay a failed invoice |
| Billing | Coupons | Write | the reusable coupon behind a discount offer |
| Billing | Prices | Read | downgrade offers |
| Webhook | Webhook Endpoints | Write | create (and on disconnect delete) Unquit's endpoint |
| *Connect* | *Accounts* | *Read (optional)* | *read the acct_ id directly; otherwise it's read from Stripe's permission error* |

3. Paste the `rk_…` key **and** the account's publishable key (`pk_…`, needed by Stripe Elements on the card-update page).

Unquit then: rejects `sk_` keys; makes a test call; probes every permission **without changing anything** (reads list one object; writes update an id that can't exist, so 404 = allowed, 403 = missing) and names any missing permission; checks the `pk_` belongs to the same account (a SetupIntent read back with it, then cancelled); creates one webhook endpoint on the founder's account (`/api/stripe/webhook/acct/<account id>`, the 12 events of the Connect webhook minus `account.application.deauthorized`, pinned to the library's API version); and stores the key and the endpoint's signing secret **encrypted with AES-256-GCM** (`STRIPE_KEY_ENCRYPTION_KEY`, AAD = the account id). The key is never sent back to the browser; only its last 4 characters are shown. **Disconnect** deletes the webhook endpoint with the founder's key and wipes the key, publishable key and signing secret.

Every founder-account Stripe call goes through `lib/stripe/connection.ts` (`StripeTarget` / `getStripeResolver(db)`): Connect mode = platform key + `Stripe-Account` header; key mode = a client built from the founder's decrypted key, no header. Migration `0008_restricted_key_mode.sql` adds the columns.

---

## The tech, in one paragraph

**Next.js 14** (App Router, TypeScript, Tailwind) runs the website and the API. **Neon** (serverless Postgres, through `@neondatabase/serverless`) stores the data. **Firebase Authentication** owns email/password credentials, verification and password recovery; Unquit exchanges verified Firebase tokens for a secure, HTTP-only app session. The official **Stripe** library handles Stripe Connect and webhooks. **Resend** sends dunning and receipt emails (without a Resend key they're written to the logs instead, so everything still runs). **Vercel Cron** runs the email sequence and ledger jobs, and **Vercel** hosts the site. Every one of these has a free tier.

```
app/
  page.tsx                     marketing landing page  (/)
  login/ signup/ signout/      email + password sign-in, sign-up and sign-out pages
  api/auth/firebase-session/   exchanges a verified Firebase token for an app session
  api/auth/[...nextauth]/      legacy Auth.js compatibility for older accounts
  api/signup/                  legacy signup compatibility endpoint
  auth/signout/route.ts        clears the session cookie (POST)
  dashboard/page.tsx           founder dashboard        (/dashboard, sign-in required)
  dashboard/flows/             cancel-flow editor       (/dashboard/flows) with live preview
  dashboard/test/              try the real widget      (/dashboard/test)
  dashboard/dunning/           failed payments: cases, settings, email editor (/dashboard/dunning)
  dashboard/saves/[receipt_number]/  a save's receipt: fees, clawbacks, timeline, Download PDF, Dispute
  dashboard/billing/           unquit's bill: running total vs the cap, card (Checkout), statements
  dashboard/billing/[month]/   one month's statement (the monthly invoice links here)
  admin/                       dispute review queue (/admin, ADMIN_EMAILS only)
  u/[token]/                   the hosted card-update page end customers land on (/u/<link>)
  api/u/[token]/setup|pay|retry|confirm   the card-update page's own API
  api/cron/dunning/            the daily run: dunning emails + ledger jobs (Vercel Cron, needs CRON_SECRET)
  api/cron/billing/            the monthly bill on the 1st (Vercel Cron, needs CRON_SECRET)
  api/saves/[receipt]/dispute/ opens a dispute (holds fees, runs the automatic checks)
  api/admin/disputes/[id]/     an admin accepts or rejects a dispute
  api/billing/setup/           starts Stripe Checkout (setup mode) to save a card
  api/dashboard/ledger/export/ the ledger as CSV
  api/dunning/click|open/      email click redirect + open pixel
  api/dunning/settings/        saves the founder's dunning settings (scoped to their account)
  api/widget/session|accept|cancel   the public widget API (CORS *, publishable key + HMAC)
  api/flows/                   saves the founder's flow (scoped to their account)
  api/dashboard/               rotate secret, sign a test customer, the activity feed (polled)
  api/stripe/connect/          step 1 of Stripe Connect (redirect to Stripe)
  api/stripe/callback/         step 2 (Stripe sends the founder back here)
  api/stripe/disconnect/       revoke access
  api/stripe/webhook/          receives Stripe events from founders' connected accounts
  api/stripe/key/              connect with a restricted key (validate, create webhook, store encrypted)
  api/stripe/webhook/acct/[id] per-account webhook for restricted-key connections (own signing secret)
  api/stripe/platform-webhook/ (optional) events on unquit's own account: saved cards, invoice status
lib/
  pricing.ts                   ALL fee maths (+ pricing.test.ts)
  saves/rules.ts               the save rules as plain functions (+ tests)
  saves/verify.ts              the save lifecycle: verify, months 2–3, lost/expired/superseded, abandoned sessions (+ tests)
  ledger/clawbacks.ts          pro-rata refunds and credit notes, chargeback holds (+ tests)
  ledger/disputes.ts           founder disputes, auto-rules, admin decisions, receipt emails (+ tests)
  ledger/receipt.ts            receipt data + the status timeline (+ tests)
  ledger/csv.ts                CSV export with formula protection (+ tests)
  ledger/testing/fakes.ts      in-memory ledger, billing repo and platform Stripe for tests
  billing/statement.ts         a month's statement maths: cap, credits (+ tests)
  billing/service.ts           the monthly invoice run, idempotent per founder and month (+ tests)
  billing/stripe-ops.ts        Invoices, Invoice Items and Checkout on the platform account
  stripe/webhook-handlers.ts   what each Stripe event does
  stripe/mrr.ts                monthly revenue of a subscription (+ tests)
  db/                          the Postgres client (Neon HTTP driver), query helpers, PGlite for tests
  auth/                        Auth.js options, the session helper, users (bcrypt), cookie names
  accounts.ts                  the founder's account, always looked up by the session's user id
  email.ts                     Resend client (logs instead of sending without RESEND_API_KEY) (+ tests)
  dunning/declines.ts          soft / hard / authentication decline categories (+ tests)
  dunning/schedule.ts          the 3-email scheduler and when it stops (+ tests)
  dunning/templates.ts         default copy, {{variables}}, Gmail/Outlook-safe HTML + text (+ tests)
  dunning/token.ts             signed, expiring, single-use-per-success links (+ tests)
  dunning/attribution.ts       who gets credit for a recovery, and the 10% fee (+ tests)
  dunning/service.ts           cases, the cron run, recoveries (+ tests with in-memory fakes)
  dunning/card-update.ts       the card-update page's logic (+ tests with a fake Stripe)
  flows/                       offer rules, abuse guard, saved MRR, templates, validation (+ tests)
  widget/service.ts            what the widget API does (+ tests with in-memory fakes)
  widget/hmac.ts               widget signatures (+ tests)
  widget/stripe-ops.ts         applies offers / cancels on the connected account
widget/                        the embeddable script's source (no framework)
  entry.ts                     window.Unquit.open()
  flow.ts                      the modal: steps, shadow DOM, focus trap (+ jsdom tests)
scripts/build-widget.mjs       bundles widget/ into public/widget.js (runs before build and dev)
db/
  migrations/0001_init.sql     the core tables (plain Postgres)
  migrations/0002_cancel_flow.sql  week 2: widget keys, flows, rate limits
  migrations/0003_dunning.sql  week 3: dunning settings + emails, sequence state, attribution
  migrations/0004_ledger_billing.sql  week 4: lost saves, clawbacks, holds, receipts timeline, disputes, billing periods
  migrations/0005_auth.sql     users (email + bcrypt hash) for Auth.js, foreign keys onto it
  migrate-core.mjs             applies migrations in order, once each (schema_migrations)
  tests/*.test.ts              runs the migrator + every migration on a real Postgres (PGlite)
scripts/migrate.mjs            `npm run db:migrate`
middleware.ts                  guards /dashboard and /admin (checks the Auth.js session cookie)
vercel.json                    the cron jobs: daily /api/cron/dunning, monthly /api/cron/billing
.env.example                   every setting the app needs (placeholders only)
```

---

## Setup guide (no coding needed)

You'll create four free accounts (Neon comes through Vercel), copy about eight keys into one settings screen, and click Deploy. It takes roughly 45 minutes. Do everything in **test mode** first: no real money moves.

> 🔑 **Golden rule:** database URLs, `AUTH_SECRET`, and keys that say *secret*, `sk_` or `whsec_` are passwords. Never paste them into chat, email, GitHub or a screenshot. They go only into Vercel's settings (step 5).

Keep a private note open (for example in your password manager) and collect these values as you go:

| Name | Where it comes from |
|---|---|
| `DATABASE_URL` | Neon (step 1), **secret**. Set for you by Vercel's Neon integration (it also sets `DATABASE_URL_UNPOOLED` and `POSTGRES_URL`, which work as fallbacks) |
| `AUTH_SECRET` | You make it up (step 5): a long random string, **secret** (`openssl rand -base64 32`) |
| `STRIPE_SECRET_KEY` | Stripe (step 2), **secret**, starts with `sk_test_` |
| `STRIPE_CONNECT_CLIENT_ID` | Stripe (step 2), starts with `ca_` |
| `STRIPE_WEBHOOK_SECRET` | Stripe (step 6), **secret**, starts with `whsec_` |
| `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` | Stripe (step 2), starts with `pk_test_` (safe to show, it's public) |
| `RESEND_API_KEY` | Resend (step 3), **secret**, starts with `re_` |
| `EMAIL_FROM_ADDRESS` | Resend (step 3), for example `billing@mail.yourdomain.com` |
| `CRON_SECRET` | You make it up (step 5): a long random password, **secret** |
| `DUNNING_LINK_SECRET` | You make it up (step 5): another long random password, **secret** |
| `NEXT_PUBLIC_APP_URL` | Vercel (step 5), for example `https://unquit.vercel.app` |
| `ADMIN_EMAILS` | You choose (step 5): the sign-in email(s) allowed into `/admin`, comma-separated |
| `STRIPE_PLATFORM_WEBHOOK_SECRET` | Stripe (step 6b), **secret**, starts with `whsec_`. *Optional* |
| `STRIPE_KEY_ENCRYPTION_KEY` | You make it up: `openssl rand -base64 32`, **secret**. Encrypts founders' restricted keys; needed for "Connect with a Stripe restricted key" (it fails closed without it). Never change it once founders have connected |
| `VERIFY_WINDOW_DAYS` | *Optional.* Days a pending save waits for a paid invoice. Leave it out for 45 |

### Step 1: Neon (the database), through Vercel

The easiest path is to create the database from Vercel, so its connection strings land in your project automatically. (You can do this after step 5's first deploy too; the first deploy simply won't work until the database exists.)

1. In **vercel.com → your project → Storage**, click **Create Database** (or **Connect Store**), choose **Neon** (Serverless Postgres), accept the defaults and pick the region closest to your Vercel functions (e.g. `us-east-1` / Washington D.C.). Connect it to **all environments**.
2. Vercel now has `DATABASE_URL`, `DATABASE_URL_UNPOOLED`, `POSTGRES_URL` and a few more under **Settings → Environment Variables**. unquit reads `DATABASE_URL` (falling back to `POSTGRES_URL`).
3. **Create the tables** from your computer (you need Node.js 20+):
   ```bash
   git clone https://github.com/sauravsah/unquit && cd unquit
   npm install
   npx vercel env pull .env.local     # or paste DATABASE_URL_UNPOOLED from Neon into .env.local
   npm run db:migrate
   ```
   It prints each migration as it applies it (`0001_init.sql` … `0005_auth.sql`) and records them in a `schema_migrations` table. Run it again any time: it only applies new files, so it's safe after every pull. *(No Vercel integration? Create a project at **neon.tech**, copy the pooled and direct connection strings from **Connection details** into `DATABASE_URL` and `DATABASE_URL_UNPOOLED`, and run the same command.)*
4. Use a separate Neon **branch** (Neon → Branches) for local development if you like; it's a copy-on-write clone, so experiments never touch production data.

> **Coming from the Supabase version?** The schema is the same tables minus the Supabase-only parts (RLS policies, `auth.uid()` helpers, grants), plus `users` and `schema_migrations`. Data is not copied automatically: to move it, `pg_dump --data-only` the `public` tables from Supabase and restore them into Neon **after** running `npm run db:migrate -- --to 0004`, insert a `users` row (same `id` as the old `auth.users` id, with a new bcrypt `password_hash`) for every founder, then run `npm run db:migrate` again for `0005`. Magic-link users have no password, so each founder needs one set.

### Step 2: Stripe (test mode)

You need a Stripe account for **Unquit itself**. This is the "platform" account that founders connect to.

1. Go to **stripe.com** and sign up. Make sure the **Test mode** switch (top right) is **on**.
2. **Keys:** open **Developers**, then **API keys**. Reveal the *Secret key* (`sk_test_…`): it goes in `STRIPE_SECRET_KEY`. Copy the *Publishable key* (`pk_test_…`): it goes in `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` (the card-update page needs it to show Stripe's card form).
3. **Turn on Connect:** open **Settings**, then **Connect**, and follow the "Get started" prompts. Choose that you're building a **platform** and that your users will use **Standard** accounts (they keep their own Stripe dashboard).
4. **Turn on OAuth:** in **Settings → Connect → Onboarding options → OAuth**:
   - Switch on **OAuth for Standard accounts**.
   - Under **Redirects**, add `https://YOUR-APP.vercel.app/api/stripe/callback` (fill this in after step 5). For local testing also add `http://localhost:3000/api/stripe/callback`.
   - Copy the **Test mode client ID** (`ca_…`). It goes in `STRIPE_CONNECT_CLIENT_ID`.

> Stripe now nudges new platforms towards its newer "Accounts" onboarding, but OAuth for Standard accounts is still supported. It's the simplest way to connect an *existing* Stripe account, which is what founders already have.

### Step 3: Resend (sends the failed-payment emails)

Resend is the service that delivers unquit's emails. Without it, nothing breaks: emails are just written to Vercel's logs instead of being sent. Set it up before you switch emails on for real customers.

1. Go to **resend.com** and sign up (there's a free plan).
2. **Add your domain.** Emails must come from a domain you own, so inboxes trust them. Open **Domains → Add domain** and type a *subdomain* of your website, for example `mail.yourdomain.com`. (A subdomain keeps these emails separate from your normal company email.)
3. **Prove you own it.** Resend shows a few records (usually 3 or 4, labelled MX and TXT). Log in to wherever you bought the domain (GoDaddy, Namecheap, Cloudflare, Google Domains…), open its **DNS settings**, and add each record exactly as Resend shows it: same *type*, same *name*, same *value*. Then click **Verify** in Resend. It can take from a few minutes to a few hours; Resend emails you when it's done.
4. **Create an API key:** **API Keys → Create API key**, permission **Sending access**. Copy it (`re_…`): it goes in `RESEND_API_KEY`. **This one is secret.**
5. **Pick the sender address** on that domain, for example `billing@mail.yourdomain.com`. It goes in `EMAIL_FROM_ADDRESS`. It doesn't need to be a real inbox. Customers see each founder's **company name** as the sender, and replies go to the reply-to address the founder sets in the dashboard.

> Founders using unquit should switch off Stripe's own failed-payment emails (in Stripe: **Settings → Billing → Subscriptions and emails**, in the failed-payments section, turn off **"Send emails when card payments fail"**) so customers don't get two emails. Keep **Smart Retries** on: unquit works alongside them.

### Step 4: GitHub

This code already lives in your GitHub repo **`unquit`**. Vercel will read it from there.

### Step 5: Vercel (hosting)

1. Go to **vercel.com** and choose **Sign up with GitHub**.
2. Click **Add New… → Project**, find **unquit**, and click **Import**. If it isn't listed, click **Adjust GitHub App Permissions** and allow the repo.
3. Leave the build settings as they are (Vercel detects Next.js). Open **Environment Variables** and add each name from the table above with its value (the Neon ones are already there if you did step 1 through Vercel).
   - For `AUTH_SECRET`, generate a random string (`openssl rand -base64 32`, or your password manager's generator, 32+ characters). It signs and encrypts sign-in sessions; changing it signs everyone out. For `NEXT_PUBLIC_APP_URL`, use `https://unquit.vercel.app` for now; you'll correct it in a minute.
   - For `CRON_SECRET` and `DUNNING_LINK_SECRET`, make up two different long random passwords (at least 32 characters each; your password manager's generator is perfect). `CRON_SECRET` stops strangers from triggering the email run; `DUNNING_LINK_SECRET` signs the card-update links in emails. Changing `DUNNING_LINK_SECRET` later makes every link already sent stop working.
   - For `ADMIN_EMAILS`, type the email address you sign in to unquit with (several? separate them with commas). Only these people can open `/admin` to review disputes; everyone else gets "page not found".
4. Click **Deploy**. When it finishes, Vercel shows your real address, for example `https://unquit-abc123.vercel.app`.
5. Go to **Settings → Environment Variables**, set `NEXT_PUBLIC_APP_URL` to that exact address (no slash at the end), then open **Deployments**, click **⋯**, and choose **Redeploy**.

**5b. Firebase Authentication.** Add the three public Firebase settings to Vercel Production: `NEXT_PUBLIC_FIREBASE_API_KEY`, `NEXT_PUBLIC_FIREBASE_PROJECT_ID` and `NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN`. Enable Email/Password in Firebase Authentication. Firebase sends verification and password-reset messages; configure the Firebase email templates and sender before inviting beta users. The app requires a verified email before creating a session. `NEXT_PUBLIC_APP_URL` remains `https://unquit.vercel.app` until a custom domain is ready.

**5c. The scheduled jobs.** Nothing to click: Vercel reads `vercel.json` and runs two jobs, sending the secret from `CRON_SECRET` automatically. You can see them under **Settings → Cron Jobs**, and press **Run** to trigger one by hand.
   - `/api/cron/dunning`, **daily at 15:00 UTC**: sends the failed-payment emails, marks pending saves past their 45 days as lost, closes cancel sessions left open for 24 hours, sends receipt emails, and bills last month if the monthly job missed anyone.
   - `/api/cron/billing`, **06:00 UTC on the 1st of each month**: sends every founder one invoice for the month before.
   Both are safe to run again: nobody is emailed or billed twice. The free (Hobby) plan allows daily jobs, which is all these need. On a paid plan you can make the dunning run hourly by changing its schedule in `vercel.json` to `0 * * * *`.

**5d. Tell Stripe your address.** Add `https://YOUR-APP.vercel.app/api/stripe/callback` to the Connect OAuth redirects (step 2.4) if you haven't already.

### Step 6: Stripe webhook

This is how Stripe tells Unquit when something happens in a founder's account.

1. In Stripe (test mode), open **Developers → Webhooks** (sometimes called **Workbench → Webhooks**) and click **Add endpoint** (or **Add destination**).
2. Choose **Events on Connected accounts**. This matters: Unquit listens to your *founders'* accounts, not your own.
3. Endpoint URL: `https://YOUR-APP.vercel.app/api/stripe/webhook`
4. Select these events:
   - `customer.subscription.created`
   - `customer.subscription.updated`
   - `customer.subscription.deleted`
   - `invoice.payment_failed`
   - `invoice.paid`
   - `account.application.deauthorized`
   - `charge.refunded` *(week 4: refund clawbacks)*
   - `credit_note.created`, `credit_note.updated`, `credit_note.voided` *(week 4)*
   - `charge.dispute.created`, `charge.dispute.updated`, `charge.dispute.closed` *(week 4: chargeback holds)*
   *(Upgrading from week 3? Open your existing endpoint, click **Update details** / **Edit destination**, and tick the seven week-4 events.)*
5. Save it, then reveal the **Signing secret** (`whsec_…`). Put it in Vercel as `STRIPE_WEBHOOK_SECRET` and **Redeploy** once more.

### Step 6b: Stripe settings for unquit's own billing

unquit bills founders from **your own** Stripe account (the platform account from step 2), not from their accounts.

1. **Invoice emails:** in Stripe open **Settings → Billing → Invoices** (or **Customer emails**) and switch on **Email finalized invoices to customers** and **Send reminders** if offered. Founders without a saved card get the invoice by email with a pay link.
2. **Card payments in Checkout:** open **Settings → Payments → Payment methods** and make sure **Cards** are on. Founders save their card through Stripe Checkout from **Dashboard → Billing**.
3. **Branding (nice to have):** **Settings → Branding**: upload a logo and set the accent colour to `#16A34A` so invoices and Checkout look like unquit.
4. **Optional second webhook** (keeps invoice status on the billing page instantly up to date). **Developers → Webhooks → Add endpoint**, this time choose **Events on your account**, URL `https://YOUR-APP.vercel.app/api/stripe/platform-webhook`, events `checkout.session.completed`, `invoice.finalized`, `invoice.paid`, `invoice.payment_failed`, `invoice.voided`, `invoice.marked_uncollectible`. Put its signing secret in Vercel as `STRIPE_PLATFORM_WEBHOOK_SECRET` and redeploy. Without it everything still works: the billing page asks Stripe for the latest status when it opens.

### Step 7: Try it

1. Open your Vercel address and click **Get started free**.
2. Click **Create an account**, enter your email and a password (8+ characters). You land on the dashboard, signed in.
3. On the dashboard, click **Connect Stripe**. Stripe asks which account to connect. In test mode you can use **"Skip this form"** or create a test account. You'll land back on the dashboard showing your connected `acct_…` id.
4. To see data flowing: in the *connected* test account, create a customer **with an email address you can read** and a subscription. Use test card `4000 0000 0000 0341` (it attaches fine, then fails when charged) to trigger a failed payment. Check **Developers → Webhooks → your endpoint** in Stripe: each event should show **200 OK**. In Neon's **Tables** view (or `select * from dunning_cases` in its SQL editor), you'll see rows in `subscriptions_cache`, `dunning_cases` and `webhook_events`.
5. **Try a receipt and a dispute.** Accept an offer at **Dashboard → Test the widget**, then in the connected test account open the subscription and pay its next invoice (**Invoices → ⋯ → Pay** or use a test clock). The save turns **Verified** in the ledger; click its receipt number. Refund part of the payment in Stripe and watch the clawback appear on the receipt. Press **Dispute this save** to try the review flow (sign in with an `ADMIN_EMAILS` address and open `/admin`).
6. **Try the monthly bill.** Run the billing job by hand for a past month: `curl -H "Authorization: Bearer YOUR_CRON_SECRET" "https://YOUR-APP.vercel.app/api/cron/billing?month=2026-09"`. In test mode the invoice appears in your platform account under **Invoices**; the statement appears under **Dashboard → Billing**.
7. **Try the failed-payment flow.** On the dashboard open **Failed payments**, type your company name, tick **Email customers when a payment fails**, and save. Trigger another failed payment as above: the day-0 email arrives within a minute (or appears in Vercel's logs if Resend isn't set up). Click the button in it, enter test card `4242 4242 4242 4242` (any future date, any CVC) and pay. Try `4000 0027 6000 3184` to see a 3-D Secure check. The case flips to **Recovered** with a 10% fee. If you instead let Stripe retry the card on its own, the case is recovered as "Stripe / other" with no fee.

### Go-live checklist

Do these in order once everything works in test mode. Tick each one.

**Accounts you need**
1. ☐ **Neon** database (step 1) connected to the Vercel project, and `npm run db:migrate` run against production (it prints "already up to date" when nothing is left).
2. ☐ **Stripe** platform account with your business details complete (**Settings → Business details**, bank account under **Settings → Payouts**). Stripe won't let live Connect or live invoices work until this is done.
3. ☐ **Resend** account with your sending domain **Verified** (step 3).
4. ☐ **GitHub** repo `unquit` and a **Vercel** project connected to it (steps 4–5).

**Stripe live keys and settings** (switch the Test-mode toggle **off** for all of these)
5. ☐ **Developers → API keys**: copy the live **Secret key** (`sk_live_…`) and **Publishable key** (`pk_live_…`).
6. ☐ **Settings → Connect**: finish the platform profile, choose **Standard** accounts, and in **Onboarding options → OAuth** switch on OAuth, add the redirect `https://YOUR-DOMAIN/api/stripe/callback`, and copy the live **client ID** (`ca_…`).
7. ☐ **Developers → Webhooks → Add endpoint → Events on Connected accounts**: URL `https://YOUR-DOMAIN/api/stripe/webhook`, all 13 events from step 6. Copy its live signing secret (`whsec_…`).
8. ☐ *(Optional)* **Add endpoint → Events on your account**: URL `https://YOUR-DOMAIN/api/stripe/platform-webhook`, the 6 events from step 6b. Copy its signing secret.
9. ☐ **Settings → Billing → Invoices**: email finalized invoices to customers is **on**. **Settings → Payments → Payment methods**: **Cards** on. **Settings → Branding**: logo + `#16A34A`.

**Vercel → Settings → Environment Variables** (Production), then **Redeploy**
10. ☐ `DATABASE_URL` (from the Neon integration) and `AUTH_SECRET` (a long random string)
11. ☐ `STRIPE_SECRET_KEY` = `sk_live_…`, `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` = `pk_live_…`, `STRIPE_CONNECT_CLIENT_ID` = live `ca_…`
12. ☐ `STRIPE_WEBHOOK_SECRET` = the live Connect endpoint's `whsec_…`; *(optional)* `STRIPE_PLATFORM_WEBHOOK_SECRET` = the platform endpoint's `whsec_…`
13. ☐ `RESEND_API_KEY` and `EMAIL_FROM_ADDRESS` (an address on your verified domain)
14. ☐ `CRON_SECRET` and `DUNNING_LINK_SECRET` (two different long random passwords; keep the same `DUNNING_LINK_SECRET` as before or old email links stop working)
15. ☐ `NEXT_PUBLIC_APP_URL` = your live address, no slash at the end (for example `https://app.unquit.com`)
16. ☐ `ADMIN_EMAILS` = your sign-in email(s)
16b. ☐ `STRIPE_KEY_ENCRYPTION_KEY` = `openssl rand -base64 32` (for restricted-key connections; keep it forever)

**Addresses to update**
17. ☐ *(Custom domain)* **Vercel → Settings → Domains**: add it, follow the DNS steps, then use it everywhere below.
18. ☐ `NEXT_PUBLIC_APP_URL` matches the live address (Auth.js uses it for its callbacks and secure cookies).
19. ☐ Create your own login at `/signup` with the email you put in `ADMIN_EMAILS`.

**Final checks**
20. ☐ **Vercel → Settings → Cron Jobs** shows `/api/cron/dunning` (daily) and `/api/cron/billing` (monthly). Press **Run** on the dunning one: it should succeed.
21. ☐ Sign in on the live site, **Connect Stripe** with a real account, and check **Developers → Webhooks** shows **200 OK** deliveries.
22. ☐ Open **Dashboard → Billing** and add a card through Checkout; it should show "•••• 1234".
23. ☐ Open `/admin` while signed in with an `ADMIN_EMAILS` address: you should see the review queue (and a 404 with any other login).

---

## For developers

```bash
npm install
cp .env.example .env.local     # fill in test-mode values (DATABASE_URL from a Neon branch, AUTH_SECRET)
npm run db:migrate             # applies db/migrations/*.sql in order, once each (idempotent)
npm run dev                    # http://localhost:3000
npm test                       # vitest: pricing + the cap, save rules, MRR, webhook routing + signature,
                               #         offers, abuse guard, HMAC, widget API, the widget DOM (jsdom),
                               #         dunning (declines, scheduler, templates, links, attribution,
                               #         cron idempotency, card-update page), the Resend client,
                               #         the ledger (3-month fee lines, lost/expiry/supersede, pro-rata
                               #         clawbacks, chargeback holds, disputes + auto-rules + admin
                               #         decisions, receipts, CSV), monthly billing (cap, credits,
                               #         idempotency, $0 months, crash recovery),
                               #         the migrator + all five SQL migrations, every SQL repo, tenant
                               #         isolation and sign-up/sign-in, on an in-memory Postgres (PGlite)
npm run build:widget           # rebuilds public/widget.js (also runs automatically before dev/build)
npm run typecheck
npm run lint
npm run build                  # builds without any env vars set
```

**Local webhooks:** install the Stripe CLI, then run
`stripe listen --forward-connect-to localhost:3000/api/stripe/webhook`
and use the `whsec_…` it prints as `STRIPE_WEBHOOK_SECRET`.

**Local cron:** `curl -H "Authorization: Bearer $CRON_SECRET" http://localhost:3000/api/cron/dunning` runs the email sequence and the daily ledger jobs once. `curl -H "Authorization: Bearer $CRON_SECRET" "http://localhost:3000/api/cron/billing?month=2026-09"` bills a past month (idempotent).

**Local platform webhook:** `stripe listen --forward-to localhost:3000/api/stripe/platform-webhook` (no `--forward-connect-to`) and use its `whsec_…` as `STRIPE_PLATFORM_WEBHOOK_SECRET`.

### Design notes

- **Money is integer cents** everywhere. Fees round **down**, so a founder is never overcharged by rounding.
- **Database access:** only server code talks to Postgres (Neon's HTTP driver, `lib/db`), with parameterised SQL (`$1, $2…`) and small helpers for compare-and-set updates. There is no row-level security and no browser database client.
- **Tenant isolation lives in the query layer:** a founder's account is always found from the session's user id (`findAccountForUser` / `getOrCreateAccount`), and every founder-facing query filters by that account id, including child rows (fee lines, events, emails) that RLS used to cover. Webhooks resolve the account from the Stripe account id, the widget from its publishable key + HMAC, the card-update page from its signed link. `/admin` is deliberately cross-account and gated by `ADMIN_EMAILS`. `lib/tenant-isolation.test.ts` checks every loader with two founders.
- **Sign-in:** Auth.js v4 Credentials provider (email + password), bcrypt (cost 12) hashes in `users`, JWT sessions in an encrypted httpOnly cookie (30 days), 10 attempts / 10 minutes per email and 30 per IP (Postgres counters). Unknown emails take as long as wrong passwords. `middleware.ts` checks the cookie for `/dashboard` and `/admin`; pages and API routes check the session again. Stripe fields on `accounts` are only written by the OAuth callback after a real code exchange.
- **Idempotent webhooks:** each Stripe event id is claimed in `webhook_events`. Duplicates return 200 and are skipped; failed events are re-run when Stripe retries. Subscription updates carry the event timestamp, so an old event that arrives late never overwrites newer data.
- **No stored Stripe tokens:** with Standard Connect, Unquit acts on a founder's account using its own platform key plus the `Stripe-Account` header, so the OAuth access token is never saved.
- **OAuth `state`** is a random value in an httpOnly cookie, checked on the way back (CSRF protection). State-changing POSTs check the `Origin` header.
- **Save verification** (`lib/saves/rules.ts`): a pending cancel save becomes verified only when an invoice on the **same subscription**, **created after the offer was accepted**, with **billing reason subscription_cycle/update** and **more than $0 paid** is paid. A $0 invoice during a free month or pause keeps the save pending.
- **Widget auth:** the publishable key only identifies the founder's account. Every call also needs `HMAC-SHA256(signing secret, "customerId:subscriptionId")`, checked in constant time, and the API confirms in Stripe that the subscription exists **on that connected account** and belongs **to that customer**. Unknown and someone-else's subscriptions get the same 404. CORS allows any origin but no cookies are used.
- **The server decides the offer.** The widget only sends a reason id. On accept, the offer is re-derived from the founder's saved flow and the live subscription, so a tampered request can't pick its own discount.
- **Idempotent accept:** Stripe calls use the idempotency key `unquit_accept_<session id>`, the session flips to accepted with a compare-and-set, and `saves.cancel_session_id` is UNIQUE, so double clicks, retries and races give one Stripe change and one pending save. A retry also repairs the ledger if the first request died between the two writes. The pause date is computed from the session's start time, so retries send Stripe identical requests.
- **Saved MRR** (the basis of the 20% fee) is conservative: discount = MRR after the discount, pause = full MRR (but nothing is earned until a real invoice is paid after the pause), downgrade = the cheaper plan's MRR. Discounts are capped at 90%, because a 100% discount means $0 invoices, which never verify a save.
- **Rate limits** are counted in Postgres (`widget_rate_limit_hit`), so they hold across serverless instances: 60 calls/minute per IP and 30 calls/10 minutes per subscription.
- **Offers are skipped** for subscriptions that aren't `active`/`trialing`, already have a discount, are already paused, or (for downgrades) are multi-item or not on a pricier plan.
- **Decline categories** (`lib/dunning/declines.ts`): Stripe's issuer `decline_code` wins over its generic error `code`. Unknown codes are treated as *hard* (asking for a new card is the safe default). The code is read from the invoice's PaymentIntent (`last_payment_error`); if Stripe can't be reached the case still opens and a later failure fills the code in.
- **The email sequence:** 3 emails per case, scheduled from the first failure (day 0/3/7 by default, 3 increasing days up to 60). A later failure updates the decline but never restarts the sequence. Before each email the cron re-checks Stripe and stops on a paid/void invoice or a cancelled subscription; `invoice.paid` and `customer.subscription.deleted` stop it too. Emails are at least 12 hours apart, cases older than 30 days get no more emails, and the sequence is **off** until a founder turns it on (so upgrading never surprises their customers).
- **No double sends:** before sending, the cron claims `(case, step)` in `dunning_emails` (UNIQUE) through `dunning_claim_email()`. A second run sees it as in flight or already sent; a failed send is retried up to 3 times; a send abandoned by a crashed run is reclaimed after 10 minutes, and Resend's idempotency key (`dunning/<case>/<step>`) stops even that from sending twice.
- **Card-update links** are `v1.<payload>.<HMAC-SHA256>` with the case id, the case's `link_nonce` and an expiry 14 days after the email. When a payment succeeds the case is recovered and its nonce rotated, so every link for it dies; a declined attempt keeps the link usable. The page and its API are rate limited (per IP and per link) and only accept same-origin POSTs.
- **Stripe on the card-update page:** with Standard Connect the customer lives on the founder's account, so the SetupIntent is created there (`Stripe-Account` header, card only, `usage: off_session`) and Stripe.js is loaded with `stripeAccount`. `on_behalf_of` is not used: it is for platform-owned charges and is not needed (or allowed) for objects created directly on the connected account. After the card is saved, it becomes the default on the customer and the subscription, and `invoices.pay` runs on-session so the bank can ask for 3-D Secure (`handleNextAction` on the page).
- **Attribution** (`lib/dunning/attribution.ts`): unquit marks the case `pending_attribution` right **before** it calls `invoices.pay` and clears the mark if the attempt fails. `invoice.paid` within 30 minutes of that mark is credited (`update_link`, or `unquit_retry` if the customer had opened an email link first); anything else is `external`. The page and the webhook both record the recovery; the flip is compare-and-set and the save is unique per case, so it's counted once, and a retried webhook repairs a save a crash left unwritten.
- **Fees and the cap:** a dunning save stores its full 10% (`saves.fee_cents`, rounded down) and one fee line. The $299 cap applies to the month's total across cancel and dunning saves, when the bill is built (`calculateMonthlyBill`); `applyMonthlyCap` gives the same answer one fee at a time.

**Week 4: ledger, clawbacks, disputes and billing**

- **Fee lines are the ledger.** Every fee is a row in `save_fee_lines`: one per paid month (cancel saves, max 3) or one per recovery (dunning), unique per `(save, month)` and per `(save, invoice)`, so a re-delivered `invoice.paid` adds nothing. `saves.fee_cents` is always the sum of its lines net of clawbacks (before the cap). Months 2 and 3 need the same subscription, a payment above $0, a cycle/update billing reason and an invoice created after the offer; they stop when the subscription is cancelled (`saves.ended_at`).
- **Lost saves:** pending → `lost` with `lost_reason` = `expired` (daily job; 45 days from acceptance, or from `resumes_at` for a pause), `superseded` (a newer offer accepted on the same subscription) or `customer_canceled` (`customer.subscription.deleted`, status `canceled`, or "No thanks, cancel" in a later session). Every flip is compare-and-set on `status = 'pending'`, so it can't race verification.
- **Clawbacks are recomputed, not added up.** Each Stripe source is stored once in `invoice_reversals` with its *cumulative* amount: `charge:<id>` = `charge.amount_refunded`, `credit_note:<id>` = the credit note's post-payment amount minus its refunds (those already arrive as `charge.refunded`), `dispute:<id>` = the disputed amount once lost. A line's clawback = fee × min(paid, Σ sources) ÷ paid, rounded **up**, and only ever grows (a voided credit note never re-charges). The line is raised with a compare-and-set on its previous value and each increase is logged in `fee_clawbacks`. Current Stripe API versions dropped `charge.invoice`, so a charge is matched to its invoice through the Invoice Payments API (payment intent → invoice).
- **Holds:** `held_stripe_dispute_id` (an open chargeback on that invoice) and `held_founder_dispute_id` (the founder's open dispute, on every line of the save, including months added while it's open). Held lines are skipped by billing and join the first statement after they're released.
- **Dispute auto-rules:** for every invoice behind the save, Stripe must say `paid` with more than $0, nothing refunded (Stripe's refunds/credit notes or ones unquit recorded), on the save's subscription and customer. Any failure accepts the dispute automatically (`resolution = 'auto'`) and reverses every line. If Stripe can't be reached the dispute waits for a human. Admin decisions are compare-and-set on `status = 'open'`; a reject needs a note, which the founder sees.
- **Disputes are opened by the server** (`/api/saves/<receipt>/dispute`, after checking the save belongs to the signed-in founder's account), so the holds and checks always run. Nothing in the ledger or billing is written from the browser.
- **Monthly billing:** `billing_periods` is unique per `(account, month)`. A run locks the row (compare-and-set, 10-minute lease), assigns that month's billable lines (verified, not held, not billed, `billing_month` ≤ the month), computes the statement, and either marks it `zero` or creates a draft invoice (`pending_invoice_items_behavior: exclude`, `auto_advance: false`), saves its id at once, adds the items, checks the draft total equals the statement, and finalizes it with `auto_advance: true` (Stripe then charges the saved card, or emails it for `send_invoice` with 14 days to pay). A crashed run deletes its leftover draft and rebuilds; an invoice that was finalized before a crash is picked up instead of duplicated. Stripe idempotency keys include the period id and attempt.
- **Credits for refunds after billing:** a closed statement's own fees are re-computed with today's clawbacks and the cap; the drop (minus credit already given) is credited on the next statement as a negative item, carrying forward if it's larger than that month. Because the cap is re-applied, a refund on a fee the cap had already waived is never paid out twice.
- **Why plain Invoices + Invoice Items, not metered billing:** unquit's price isn't a per-unit rate. It's a ledger of individual saves that can be held, clawed back pro-rata or reversed by a dispute *after* they happen, with a monthly cap and credits across months. Stripe Billing Meters only add usage (corrections are limited to cancelling recent meter events), would need a subscription per founder, and would put the cap and clawback logic in two places. With plain invoices unquit computes the month from its own ledger, every invoice line maps to a statement that lists each receipt, nothing is sent to Stripe until the month is final, and a re-run is easy to make idempotent. The trade-off: no live "upcoming invoice" in Stripe (the billing page shows the running total instead).
- **Receipts and statements** are server-rendered from account-scoped reads; "Download PDF" is the browser's Save as PDF with print CSS (no PDF library). Timeline lines come from `save_events` (append-only, deduped by `dedupe_key`). Receipt emails are claimed per save (`receipt_emailed_at`, compare-and-set) and sent with a Resend idempotency key, from the webhook and again by the daily job if that failed.
- **CSV export** uses the table's filters, RFC 4180 quoting, and prefixes cells starting with `= + - @` with an apostrophe so a customer's email can't run as a spreadsheet formula.
- **Emails:** table-based HTML with inline styles and a "bulletproof" button (works in Gmail and Outlook), plus a plain-text version. Founder text is escaped; variables are `{{customer_name}}`, `{{amount}}`, `{{update_link}}`, `{{company}}`. The button and a fallback link are always included, even if a founder deletes `{{update_link}}`. Open tracking is a 1×1 image and only approximate (many mail apps block or pre-load images); clicks are the reliable signal.
- **Known simplifications:** MRR ignores discounts, tax and metered prices. unquit's own invoices are in USD; fees from founders billing in other currencies are added as if they were USD cents (multi-currency billing is not handled yet). unquit doesn't schedule its own card retries: Stripe Smart Retries handle soft declines, and unquit only retries when the customer asks on the page. All four weeks' planned hooks are done: there are no `TODO(week` markers left.

---

## UI

The interface is built from a small design system so pages stay consistent and new screens are quick to assemble. Bar: Linear / Vercel / Stripe. Near-black ink, white and zinc surfaces, one green accent (`#16A34A`) with a glow, Geist via `geist/font`.

**Tokens** (`tailwind.config.ts`, `app/globals.css`). Colours are CSS variables, so every component works in light **and** dark mode. Use the tokens, not raw greys:

| Token | Use |
|---|---|
| `bg-background` / `bg-surface` / `bg-card` / `bg-muted` | page, app canvas, cards, wells |
| `text-foreground` / `text-muted-foreground` / `text-subtle` | body text, secondary text, hints |
| `border-border`, `border-input` | hairlines, form fields |
| `bg-brand`, `text-brand-text`, `bg-brand-soft`, `shadow-glow` | the accent, accessible green text, tinted surfaces, the glow |
| `danger`, `warning` (+ `-soft`) | errors and warnings |

Dark mode uses `next-themes` (class strategy) and follows the OS until the user picks Light/Dark/System (top bar, Settings, or `⇧D`). Add `className="light"` to a subtree to force the light palette (the public `/u/<link>` page does). Older classes (`bg-white`, `text-neutral-500`, …) still read correctly in dark mode through a small compatibility layer at the end of `globals.css`.

**Components** (`components/ui/*`, Radix underneath for accessibility; also re-exported from `@/components/ui`):

```tsx
import { Button } from "@/components/ui/button";
import { StatCard } from "@/components/ui/stat-card";
import { DataTable, type Column } from "@/components/ui/data-table";
import { toast } from "@/components/ui/toast";

<Button variant="brand" loading={saving} onClick={save}>Save flow</Button>    // primary | brand | secondary | ghost | outline | danger | link
<Button asChild variant="secondary"><Link href="/dashboard">Back</Link></Button>
<StatCard label="Saved MRR" value={cents} format="cents" delta={0.12} emphasis aside={<ProgressRing value={0.4} label="Cap" />} />
<DataTable columns={columns} rows={rows} getRowId={(r) => r.id} empty={<EmptyState title="No saves yet" art="receipts" />} />
toast.success("Saved");
```

- `Button` (variants, sizes, `loading`, press feedback, `asChild`), `Card*`, `Badge` / `StatusPill` (picks the tone from a status), `Input` / `Textarea` / `NativeSelect` / `Field` / `Kbd`, `Select`, `Switch`, `Tabs` (animated indicator, `underline` or `pill`), `Dialog` / `Sheet` (right, left or bottom), `Tooltip`, `DropdownMenu`, `Toaster` + `toast` (sonner), `Skeleton`, `DataTable` (sortable, sticky header, stacked cards on phones, new rows flash), `EmptyState` (SVG illustrations), `StatCard` + `DeltaChip`, `NumberTicker`, `ProgressRing` / `ProgressBar`, `Accordion`, `Slider`.
- `useOptimisticValue(initial, save)` (`components/ui/use-optimistic.ts`): flips the UI at once, saves in the background, rolls back with a toast on error.
- Motion (`components/motion`): `PageTransition`, `Stagger` + `StaggerItem`, `Reveal`, `HoverLift`. Framer Motion is wrapped in `MotionConfig reducedMotion="user"`, and `globals.css` turns CSS animation off for `prefers-reduced-motion`.

**Dashboard shell** (`app/dashboard/layout.tsx` → `components/app-shell`): collapsible sidebar (`[`), breadcrumb top bar, theme toggle, user menu, `⌘K` command palette, `?` shortcuts sheet, `G` + letter to jump, and a bottom nav on phones. Add a page by adding it to `NAV` in `components/app-shell/nav.ts`; it shows up in the sidebar, palette and shortcuts. Pages render their own content; `DashboardShell` is now a pass-through kept for compatibility, and `PageHeader` gives the standard title row. Every route has a `loading.tsx` skeleton (`components/dashboard/Skeletons.tsx`).

**Live overview.** The activity feed polls `/api/dashboard/activity` every 10 seconds while the tab is visible (and on focus), scoped on the server to the signed-in founder's account. New rows slide in and flash, and a new event also refreshes the server-rendered stats and charts. The badge says "Live", or "Reconnecting" if a poll fails. (Supabase Realtime is gone; nothing to configure.)

**The widget** (`widget/styles.ts`) uses the same look: rounded 18px card, soft shadow, spring entrance, bottom sheet on phones. It follows the visitor's OS dark mode; a `.dark` / `.light` class or `data-theme` on the host page wins in Chromium browsers.
