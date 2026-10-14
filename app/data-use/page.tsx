import type { Metadata } from "next";
import Link from "next/link";
import { LegalPage, List, Mail, Section } from "@/components/legal/LegalPage";

export const metadata: Metadata = {
  title: "How Unquit uses your Stripe data · unquit",
  description: "Exactly which Stripe objects Unquit reads, which it changes, when, and why.",
};

const READS = [
  { what: "Subscriptions", why: "Status, plan, price and discounts, to pick a fitting offer, work out saved MRR and check whether a save is still paying." },
  { what: "Invoices and invoice payments", why: "To see when a renewal fails or is paid, which invoice proved a save, and how much was paid or refunded." },
  { what: "Customers (via invoices and subscriptions)", why: "The customer id, and the email address and name on a failed invoice, so the failed-payment email reaches the right person." },
  { what: "Payment status", why: "Stripe’s decline code on a failed payment (for example insufficient funds or an expired card) and whether a new card was saved. Never card numbers." },
  { what: "Prices and products", why: "To show plan names and offer a cheaper plan in the cancel flow." },
  { what: "Charges, credit notes and disputes (via webhooks)", why: "To reverse or hold Unquit’s fee when you refund a saved customer or they file a chargeback." },
];

const WRITES = [
  { what: "Coupons and discounts", why: "Creates a reusable coupon such as “30% off for 3 months” and attaches it to the subscription when your customer accepts a discount offer." },
  { what: "Pauses", why: "Pauses collection on a subscription until the date your customer chose, when they accept a pause offer." },
  { what: "Plan changes", why: "Moves the subscription to the cheaper price you set up, from the next renewal, when they accept a downgrade." },
  { what: "Cancellations", why: "Cancels the subscription (at period end, or immediately if you chose that) when your customer says “No thanks, cancel”, with their reason." },
  { what: "Invoice retries and card updates", why: "When your customer uses the card-update page: saves their new card as the default and pays the open invoice, or retries their current card." },
  { what: "Webhook endpoint (restricted-key connections only)", why: "Creates one webhook endpoint pointing at Unquit so we hear about renewals, failures and refunds, and deletes it when you disconnect." },
];

function Table({ rows }: { rows: { what: string; why: string }[] }) {
  return (
    <div className="overflow-hidden rounded-xl border border-border bg-card">
      <table className="w-full text-left text-sm">
        <thead className="bg-muted/60 text-xs uppercase tracking-wide text-muted-foreground">
          <tr>
            <th scope="col" className="w-1/3 px-4 py-2.5 font-medium">Stripe data</th>
            <th scope="col" className="px-4 py-2.5 font-medium">Why</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {rows.map((r) => (
            <tr key={r.what} className="align-top">
              <th scope="row" className="px-4 py-3 font-medium text-foreground">{r.what}</th>
              <td className="px-4 py-3 text-muted-foreground">{r.why}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function DataUsePage() {
  return (
    <LegalPage
      current="/data-use"
      title="How Unquit uses your Stripe data"
      intro="Unquit works only with Stripe. This page lists what it reads, what it changes, and the one rule behind every change: it only acts on your behalf, for the features you set up."
    >
      <Section title="What Unquit reads">
        <Table rows={READS} />
      </Section>

      <Section title="What Unquit changes, and only when">
        <p>
          Every change below is triggered by <strong>your customer’s own action</strong> in the cancel flow or on the card-update page,
          using the offers and settings <strong>you</strong> configured. Each change carries an idempotency key, so a double click never
          applies anything twice.
        </p>
        <Table rows={WRITES} />
        <p>Unquit never refunds payments, moves money out of your account, changes payouts or bank details, or deletes customers.</p>
      </Section>

      <Section title="Emails to your customers">
        <p>
          Only if you switch on “Email customers when a payment fails”. When a renewal fails, Unquit sends up to 3 emails (by default on day
          0, 3 and 7) from your company name, with your reply-to address, linking to a secure card-update page. The sequence stops the
          moment the invoice is paid, voided or the subscription is cancelled. Unquit never sends marketing emails to your customers.
        </p>
      </Section>

      <Section title="How Unquit connects">
        <List>
          <li><strong>Stripe Connect (OAuth):</strong> you approve Unquit in Stripe. Unquit uses its own platform key and your account id; no key of yours is stored.</li>
          <li>
            <strong>Restricted key:</strong> you create a key in your Stripe dashboard with only the permissions listed in the dashboard and
            paste it in. Unquit encrypts it (AES-256-GCM), never shows it again (only its last 4 characters) and deletes it when you
            disconnect. You can also revoke it in Stripe at any time.
          </li>
        </List>
      </Section>

      <Section title="Fees in one paragraph">
        <p>
          No base fee. 20% of the monthly revenue kept by a cancel save, for its first 3 paid months. 10% of a failed payment Unquit
          recovered, once. Never more than $299 in a month. Refunds claw the fee back pro-rata, chargebacks hold it, and every save has a
          receipt you can dispute. One invoice a month. Full details are in the{" "}
          <Link href="/terms#fees" className="font-medium text-brand-text underline-offset-4 hover:underline">Terms</Link>.
        </p>
      </Section>

      <Section title="Retention">
        <p>
          See{" "}
          <Link href="/privacy" className="font-medium text-brand-text underline-offset-4 hover:underline">Privacy Policy</Link> for how long
          data is kept and how to delete it. Questions about a specific change Unquit made in your Stripe account: <Mail />.
        </p>
      </Section>
    </LegalPage>
  );
}
