import type { Metadata } from "next";
import Link from "next/link";
import { LEGAL_OPERATOR, LegalPage, List, Mail, Section } from "@/components/legal/LegalPage";

export const metadata: Metadata = {
  title: "Privacy Policy · unquit",
  description: "What personal data Unquit collects about founders and their customers, why, who processes it, how long it is kept and how to delete it.",
};

const SUBPROCESSORS = [
  { name: "Vercel", what: "Hosts the website, the dashboard and the API, and keeps short-lived server logs." },
  { name: "Neon", what: "The Postgres database where Unquit’s records are stored." },
  { name: "Stripe", what: "Your connected Stripe account (where your customers’ billing lives), the secure card form on the card-update page, and Unquit’s own monthly invoices to you." },
  { name: "Resend", what: "Sends the failed-payment emails to your customers and receipt and billing emails to you." },
  { name: "Google Analytics", what: "Counts visits to the public marketing pages. It is switched off on the dashboard, the card-update pages your customers see and developer setup links." },
];

export default function PrivacyPage() {
  return (
    <LegalPage
      current="/privacy"
      title="Privacy Policy"
      intro="What Unquit collects, why, who else handles it, how long it is kept and how to get it deleted."
    >
      <Section title="Who is responsible">
        <p>
          Unquit is run by <strong>{LEGAL_OPERATOR}</strong>. For founders’ own account data, Unquit decides how it is used. For your
          customers’ data, <strong>you</strong> are in charge and Unquit processes it on your behalf, only to run the features you turn
          on.
        </p>
      </Section>

      <Section title="What we collect about founders">
        <List>
          <li><strong>Your login:</strong> email address and a bcrypt hash of your password (never the password itself).</li>
          <li><strong>Your settings:</strong> company name, reply-to address, cancel-flow offers, dunning email copy and schedule.</li>
          <li>
            <strong>Your Stripe connection:</strong> your Stripe account id and whether it is in test or live mode. If you connect with a
            restricted key, we store that key and the webhook signing secret <strong>encrypted</strong> (AES-256-GCM), plus your Stripe
            publishable key and the last 4 characters of the restricted key so you can recognise it.
          </li>
          <li>
            <strong>Billing:</strong> your saves, fees, statements and disputes. If you save a card for Unquit’s bill, Stripe Checkout
            collects it; we only see the brand and last 4 digits.
          </li>
        </List>
      </Section>

      <Section title="What we process about your customers">
        <p>Only what the features need, read from your Stripe account or from the cancel flow:</p>
        <List>
          <li>Stripe ids for the customer, subscription, invoice and price; plan, amount, currency and status.</li>
          <li>Cancel flow: the reason they picked, any comment they typed, and the offer they accepted or declined.</li>
          <li>
            Failed payments: their email address and name (from the Stripe invoice), the invoice number and amount, Stripe’s decline code,
            which emails were sent, and when the card-update link was opened or clicked.
          </li>
          <li>
            Card details typed on the card-update page go <strong>straight to Stripe</strong> through Stripe’s own card form. Unquit never
            sees or stores card numbers.
          </li>
        </List>
        <p>
          Full details of each Stripe object Unquit reads and changes are on the{" "}
          <Link href="/data-use" className="font-medium text-brand-text underline-offset-4 hover:underline">Data Use</Link> page.
        </p>
      </Section>

      <Section title="Technical data and cookies">
        <List>
          <li>A sign-in cookie that keeps you logged in to the dashboard.</li>
          <li>IP addresses, briefly, to rate-limit the public cancel-flow API, and in Vercel’s short-lived request logs.</li>
          <li>Your light or dark theme choice, saved in your browser.</li>
          <li>Google Analytics cookies on the public pages only (home, sign-up, sign-in and these policy pages).</li>
        </List>
      </Section>

      <Section title="Why we use it">
        <List>
          <li>To run Unquit for you: apply offers, send the failed-payment emails you turned on, prove saves and bill you.</li>
          <li>To keep it secure: sign-in, rate limits, fraud and abuse checks.</li>
          <li>To contact you about your account, receipts, disputes and bills.</li>
          <li>To understand which marketing pages are visited (Google Analytics, marketing pages only).</li>
        </List>
        <p>We don’t sell personal data, we don’t use your customers’ data for advertising, and we don’t email your customers for our own purposes.</p>
      </Section>

      <Section title="Who else handles it (subprocessors)">
        <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-card">
          {SUBPROCESSORS.map((s) => (
            <li key={s.name} className="px-4 py-3">
              <p className="font-medium text-foreground">{s.name}</p>
              <p className="mt-0.5 text-sm">{s.what}</p>
            </li>
          ))}
        </ul>
        <p>Their servers may be outside India (for example in the United States). We’ll update this list before adding a new one.</p>
      </Section>

      <Section title="How long we keep it, and deleting it">
        <List>
          <li>
            <strong>When you disconnect Stripe,</strong> Unquit stops reading and writing your Stripe account straight away. For a
            restricted-key connection we delete the webhook endpoint Unquit created in your Stripe account and wipe the stored key and
            signing secret. For Stripe Connect we revoke Unquit’s access.
          </li>
          <li>
            Records already collected (saves, receipts, statements, disputes and failed-payment cases) are kept after you disconnect, so
            your receipts and bills stay correct and any open disputes can finish.
          </li>
          <li>
            <strong>Ask us to delete everything</strong> by emailing <Mail /> from your account email. We’ll delete your account and all
            records linked to it, including your customers’ data, within 30 days. Invoices Unquit already sent you stay in Stripe as billing
            records.
          </li>
          <li>
            If one of your customers asks you to delete their data, email us their Stripe customer id and we’ll remove what Unquit holds
            about them.
          </li>
        </List>
      </Section>

      <Section title="Security">
        <p>
          Everything is sent over HTTPS. Passwords are hashed with bcrypt, restricted keys and webhook secrets are encrypted at rest, and
          every database query is scoped to your own account. No system is perfectly secure; if we learn of a breach affecting your data,
          we’ll tell you by email without undue delay.
        </p>
      </Section>

      <Section title="Your rights">
        <p>
          You can ask to see, correct, export or delete your data, or object to how it is used. Email <Mail /> and we’ll reply within 30
          days.
        </p>
      </Section>
    </LegalPage>
  );
}
