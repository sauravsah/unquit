# unquit

**Unquit your customers. Pay only for the ones we keep.**

Unquit is churn recovery for subscription businesses that bill with **Stripe**.

A founder connects their Stripe account in one click. Unquit then:

1. **Catches cancellations**: a cancel-flow widget shows the right offer (a discount, a pause, or a downgrade) and a short exit survey. *(Week 2, live)*
2. **Recovers failed payments**: a short email sequence matched to why the card failed, and a hosted "update your card" page that pays the invoice on the spot. *(Week 3, live)*
3. **Charges only for proof**: each save gets a receipt and a Dispute button. *(Week 4)*

### Pricing (built into `lib/pricing.ts`)

| | |
|---|---|
| Base fee | **$0** |
| Cancel save | **20% of the saved MRR** for each of the first **3 months** the customer keeps paying |
| Failed-payment save | **10% of the amount recovered** |
| Monthly cap | **$299** per founder per month, no matter what |
| Refunds | If the customer is refunded inside the dispute window, the fee is **clawed back** |

### What counts as a "save"

- **Cancel save**: the customer accepted an offer inside the cancel flow **and** their next invoice was paid (more than $0). Until that invoice is paid, the save stays *pending* and costs nothing.
- **Dunning save**: a failed invoice that was paid through **Unquit's** retry or Unquit's card-update link. If the money came in some other way, it isn't billed.

---

## Roadmap

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
- [ ] **Week 4: Ledger, receipts and billing.** Fees for months 2 and 3, receipt emails with a Dispute button, refund clawbacks, and Stripe metered billing with the $299 cap.

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
  // result.outcome is "saved" (offer accepted), "canceled", or "dismissed" (closed, nothing changed)
  if (result.outcome !== "dismissed") location.reload();
});
```

That's it. Unquit applies the offer or the cancellation directly in your Stripe account. Edit the reasons and offers at **Dashboard → Cancel flow**, and try it end to end at **Dashboard → Test the widget** with a test-mode customer.

- **Offers:** a percentage discount for N months (a Stripe coupon, `duration: repeating`), a pause of 1–3 months (`pause_collection` with `resumes_at`, invoices voided while paused), or a downgrade to a cheaper price (no proration; the lower price applies from the next renewal).
- **Cancelling:** at the end of the paid period by default (`cancel_at_period_end`), or immediately if you choose that in the flow settings. The reason is written to Stripe's `cancellation_details` too.
- **Abuse guard:** a subscription can accept at most one offer every 90 days (change it in the flow settings). After that the customer still sees the survey, then goes straight to the cancel confirmation.
- **Rotating the secret:** Overview → Widget keys → *Rotate secret*. Signatures made with the old secret stop working immediately, so update your server at the same time.

---

## The tech, in one paragraph

**Next.js 14** (App Router, TypeScript, Tailwind) runs the website and the API. **Supabase** stores the data in Postgres and handles sign-in with email magic links. The official **Stripe** library handles Stripe Connect and webhooks. **Resend** sends the dunning emails (without a Resend key they're written to the logs instead, so everything still runs). **Vercel Cron** runs the email sequence once a day. **Vercel** hosts the site. Every one of these has a free tier.

```
app/
  page.tsx                     marketing landing page  (/)
  login/                       magic-link sign-in       (/login)
  auth/callback/route.ts       where the email link lands
  auth/signout/route.ts
  dashboard/page.tsx           founder dashboard        (/dashboard, sign-in required)
  dashboard/flows/             cancel-flow editor       (/dashboard/flows) with live preview
  dashboard/test/              try the real widget      (/dashboard/test)
  dashboard/dunning/           failed payments: cases, settings, email editor (/dashboard/dunning)
  u/[token]/                   the hosted card-update page end customers land on (/u/<link>)
  api/u/[token]/setup|pay|retry|confirm   the card-update page's own API
  api/cron/dunning/            the daily email run (Vercel Cron, needs CRON_SECRET)
  api/dunning/click|open/      email click redirect + open pixel
  api/dunning/settings/        saves the founder's dunning settings (RLS-bound)
  api/widget/session|accept|cancel   the public widget API (CORS *, publishable key + HMAC)
  api/flows/                   saves the founder's flow (RLS-bound)
  api/dashboard/               rotate secret, sign a test customer
  api/stripe/connect/          step 1 of Stripe Connect (redirect to Stripe)
  api/stripe/callback/         step 2 (Stripe sends the founder back here)
  api/stripe/disconnect/       revoke access
  api/stripe/webhook/          receives Stripe events
lib/
  pricing.ts                   ALL fee maths (+ pricing.test.ts)
  saves/rules.ts               the save rules as plain functions (+ tests)
  saves/verify.ts              flips pending saves to verified on invoice.paid
  stripe/webhook-handlers.ts   what each Stripe event does
  stripe/mrr.ts                monthly revenue of a subscription (+ tests)
  supabase/                    database clients (browser, server, admin)
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
supabase/
  migrations/0001_init.sql     the whole database: tables + security rules
  migrations/0002_cancel_flow.sql  week 2: widget keys, flows, rate limits
  migrations/0003_dunning.sql  week 3: dunning settings + emails, sequence state, attribution
  tests/migration*.test.ts     runs the SQL on a real Postgres and checks the security rules
middleware.ts                  keeps you signed in, guards /dashboard
vercel.json                    the daily cron job for /api/cron/dunning
.env.example                   every setting the app needs (placeholders only)
```

---

## Setup guide (no coding needed)

You'll create four free accounts, copy about eight keys into one settings screen, and click Deploy. It takes roughly 45 minutes. Do everything in **test mode** first: no real money moves.

> 🔑 **Golden rule:** keys that say *secret*, *service_role*, `sk_` or `whsec_` are passwords. Never paste them into chat, email, GitHub or a screenshot. They go only into Vercel's settings (step 5).

Keep a private note open (for example in your password manager) and collect these values as you go:

| Name | Where it comes from |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase (step 1) |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase (step 1) |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase (step 1), **secret** |
| `STRIPE_SECRET_KEY` | Stripe (step 2), **secret**, starts with `sk_test_` |
| `STRIPE_CONNECT_CLIENT_ID` | Stripe (step 2), starts with `ca_` |
| `STRIPE_WEBHOOK_SECRET` | Stripe (step 6), **secret**, starts with `whsec_` |
| `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` | Stripe (step 2), starts with `pk_test_` (safe to show, it's public) |
| `RESEND_API_KEY` | Resend (step 3), **secret**, starts with `re_` |
| `EMAIL_FROM_ADDRESS` | Resend (step 3), for example `billing@mail.yourdomain.com` |
| `CRON_SECRET` | You make it up (step 5): a long random password, **secret** |
| `DUNNING_LINK_SECRET` | You make it up (step 5): another long random password, **secret** |
| `NEXT_PUBLIC_APP_URL` | Vercel (step 5), for example `https://unquit.vercel.app` |

### Step 1: Supabase (database + sign-in)

1. Go to **supabase.com**, then **Start your project**, and sign up (GitHub sign-in is easiest).
2. Click **New project**. Name it `unquit`, choose a strong database password (save it), and pick the region closest to your customers. Click **Create**, then wait about 2 minutes.
3. **Create the tables.** In the left menu, open **SQL Editor** and click **New query**. Open the file `supabase/migrations/0001_init.sql` from this repo on GitHub, click the **Copy raw file** button, paste it into the editor, and click **Run**. You should see "Success. No rows returned." Then do the same with `supabase/migrations/0002_cancel_flow.sql` in a new query, and then `supabase/migrations/0003_dunning.sql` in another. Always run them in order: 0001, 0002, 0003. *(Already set up for an earlier week? Just run the ones you haven't run yet. For week 3 that's only `0003_dunning.sql`. It keeps your data, and failed-payment emails stay **off** until you switch them on in the dashboard.)*
4. **Copy your keys.** Open **Project Settings** (gear icon), then **API**:
   - *Project URL* goes in `NEXT_PUBLIC_SUPABASE_URL`
   - *anon / public* key goes in `NEXT_PUBLIC_SUPABASE_ANON_KEY`
   - *service_role* key (click Reveal) goes in `SUPABASE_SERVICE_ROLE_KEY`. **This one is secret.**
   - (Newer projects may label these "Publishable key" and "Secret key". Use those instead.)
5. Come back after step 5 to finish the sign-in settings (step 5b).

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
3. Leave the build settings as they are (Vercel detects Next.js). Open **Environment Variables** and add each name from the table above with its value. For `NEXT_PUBLIC_APP_URL`, use `https://unquit.vercel.app` for now; you'll correct it in a minute.
   - For `CRON_SECRET` and `DUNNING_LINK_SECRET`, make up two different long random passwords (at least 32 characters each; your password manager's generator is perfect). `CRON_SECRET` stops strangers from triggering the email run; `DUNNING_LINK_SECRET` signs the card-update links in emails. Changing `DUNNING_LINK_SECRET` later makes every link already sent stop working.
4. Click **Deploy**. When it finishes, Vercel shows your real address, for example `https://unquit-abc123.vercel.app`.
5. Go to **Settings → Environment Variables**, set `NEXT_PUBLIC_APP_URL` to that exact address (no slash at the end), then open **Deployments**, click **⋯**, and choose **Redeploy**.

**5b. Tell Supabase your address.** In Supabase, open **Authentication → URL Configuration**:
   - *Site URL*: your Vercel address
   - *Redirect URLs*: add `https://YOUR-APP.vercel.app/auth/callback` (and `http://localhost:3000/auth/callback` for local testing)

**5c. The daily email run.** Nothing to click: Vercel reads `vercel.json` and calls `/api/cron/dunning` once a day (15:00 UTC), sending the secret from `CRON_SECRET` automatically. You can see it under **Settings → Cron Jobs**, and press **Run** there to trigger it by hand. The free (Hobby) plan allows one run a day, which suits the day 0 / 3 / 7 schedule; the day-0 email goes out straight away when the payment fails anyway. On a paid plan you can make it hourly by changing the schedule in `vercel.json` to `0 * * * *`.

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
5. Save it, then reveal the **Signing secret** (`whsec_…`). Put it in Vercel as `STRIPE_WEBHOOK_SECRET` and **Redeploy** once more.

### Step 7: Try it

1. Open your Vercel address and click **Get started free**.
2. Enter your email, then click the link in the email from Supabase.
   *(Supabase's built-in email sender is limited to a few emails per hour on the free plan. That's plenty for testing. Later you can plug in Resend under Supabase → Authentication → SMTP.)*
3. On the dashboard, click **Connect Stripe**. Stripe asks which account to connect. In test mode you can use **"Skip this form"** or create a test account. You'll land back on the dashboard showing your connected `acct_…` id.
4. To see data flowing: in the *connected* test account, create a customer **with an email address you can read** and a subscription. Use test card `4000 0000 0000 0341` (it attaches fine, then fails when charged) to trigger a failed payment. Check **Developers → Webhooks → your endpoint** in Stripe: each event should show **200 OK**. In Supabase's **Table Editor**, you'll see rows in `subscriptions_cache`, `dunning_cases` and `webhook_events`.
5. **Try the failed-payment flow.** On the dashboard open **Failed payments**, type your company name, tick **Email customers when a payment fails**, and save. Trigger another failed payment as above: the day-0 email arrives within a minute (or appears in Vercel's logs if Resend isn't set up). Click the button in it, enter test card `4242 4242 4242 4242` (any future date, any CVC) and pay. Try `4000 0027 6000 3184` to see a 3-D Secure check. The case flips to **Recovered** with a 10% fee. If you instead let Stripe retry the card on its own, the case is recovered as "Stripe / other" with no fee.

### Going live later

Repeat steps 2 and 6 with the Test-mode switch **off** to get live keys (`sk_live_…`, a live `ca_…` client ID, and a new `whsec_…`). Swap them into Vercel and redeploy. Stripe will ask you to complete your platform profile before live Connect works.

---

## For developers

```bash
npm install
cp .env.example .env.local     # fill in test-mode values
npm run dev                    # http://localhost:3000
npm test                       # vitest: pricing + the cap, save rules, MRR, webhook routing + signature,
                               #         offers, abuse guard, HMAC, widget API, the widget DOM (jsdom),
                               #         dunning (declines, scheduler, templates, links, attribution,
                               #         cron idempotency, card-update page), the Resend client,
                               #         and all three SQL migrations on an in-memory Postgres (PGlite)
npm run build:widget           # rebuilds public/widget.js (also runs automatically before dev/build)
npm run typecheck
npm run build                  # builds without any env vars set
```

**Local webhooks:** install the Stripe CLI, then run
`stripe listen --forward-connect-to localhost:3000/api/stripe/webhook`
and use the `whsec_…` it prints as `STRIPE_WEBHOOK_SECRET`.

**Local cron:** `curl -H "Authorization: Bearer $CRON_SECRET" http://localhost:3000/api/cron/dunning` runs the email sequence once.

### Design notes

- **Money is integer cents** everywhere. Fees round **down**, so a founder is never overcharged by rounding.
- **Security (row-level security):** every table has RLS on. Founders can read only rows for their own account. Column grants mean the browser can set only `owner_user_id` and `name`, so nobody can forge a `stripe_account_id`. Webhook writes use the service-role key on the server.
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
- **Emails:** table-based HTML with inline styles and a "bulletproof" button (works in Gmail and Outlook), plus a plain-text version. Founder text is escaped; variables are `{{customer_name}}`, `{{amount}}`, `{{update_link}}`, `{{company}}`. The button and a fallback link are always included, even if a founder deletes `{{update_link}}`. Open tracking is a 1×1 image and only approximate (many mail apps block or pre-load images); clicks are the reliable signal.
- **Known simplifications:** MRR ignores discounts, tax and metered prices. unquit doesn't schedule its own card retries: Stripe Smart Retries handle soft declines, and unquit only retries when the customer asks on the page. Search the code for `TODO(week` to find every planned hook.

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

**Live overview.** The activity feed subscribes to Supabase Realtime on `saves`, `cancel_sessions` and `dunning_cases` (filtered to the account; RLS applies) and refreshes the stats when something changes. Realtime only sends changes for tables in the `supabase_realtime` publication, so run this once in the Supabase SQL editor to switch it on:

```sql
alter publication supabase_realtime add table public.saves, public.cancel_sessions, public.dunning_cases;
```

Without it the feed falls back to polling every 15 seconds (SWR) and the badge says "Auto-refresh" instead of "Live".

**The widget** (`widget/styles.ts`) uses the same look: rounded 18px card, soft shadow, spring entrance, bottom sheet on phones. It follows the visitor's OS dark mode; a `.dark` / `.light` class or `data-theme` on the host page wins in Chromium browsers.
