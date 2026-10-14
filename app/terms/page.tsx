import type { Metadata } from "next";
import Link from "next/link";
import { LEGAL_OPERATOR, LegalPage, List, Mail, Section } from "@/components/legal/LegalPage";

export const metadata: Metadata = {
  title: "Terms of Service · unquit",
  description: "The terms for using Unquit: what it does in your Stripe account, what it costs, and how fees, receipts, disputes and clawbacks work.",
};

export default function TermsPage() {
  return (
    <LegalPage
      current="/terms"
      title="Terms of Service"
      intro="The deal between you and Unquit, in plain English: what Unquit does in your Stripe account, what it costs, and what each of us is responsible for."
    >
      <Section title="1. Who we are">
        <p>
          Unquit is run by <strong>{LEGAL_OPERATOR}</strong>. Unquit is not a registered company. When these terms say “Unquit”, “we” or
          “us”, they mean Saurav Kumar Sah. “You” means the business, or the person acting for it, that creates an Unquit account.
        </p>
        <p>
          By creating an account or connecting a Stripe account, you agree to these terms, the{" "}
          <Link href="/privacy" className="font-medium text-brand-text underline-offset-4 hover:underline">Privacy Policy</Link> and the{" "}
          <Link href="/data-use" className="font-medium text-brand-text underline-offset-4 hover:underline">Data Use</Link> page. If you
          don’t agree, please don’t use Unquit.
        </p>
      </Section>

      <Section title="2. What Unquit does">
        <p>Unquit is churn recovery for subscription businesses that bill with Stripe. It works only with Stripe. It does three things:</p>
        <List>
          <li>
            <strong>Cancel flow.</strong> A script you add to your app shows your customer a short exit survey and, where you set one up, an
            offer (a discount, a pause or a cheaper plan). If they accept, Unquit applies it in your Stripe account. If they still want to
            leave, Unquit cancels the subscription the way you chose.
          </li>
          <li>
            <strong>Failed payments.</strong> When a renewal payment fails, Unquit can email your customer (only if you turn this on) with a
            link to a page where they can update their card and pay the open invoice.
          </li>
          <li>
            <strong>Receipts and billing.</strong> Each save gets a receipt showing the Stripe invoice that proved it, and you get one
            statement a month, charged automatically to your billing card.
          </li>
        </List>
      </Section>

      <Section title="3. Connecting Stripe and what you authorise">
        <p>
          You connect your Stripe account either through Stripe Connect (OAuth) or by pasting a Stripe <strong>restricted key</strong>{" "}
          that you create yourself with only the permissions Unquit lists. You can disconnect at any time from the dashboard (and, for
          Stripe Connect, from your Stripe dashboard too).
        </p>
        <p>
          By connecting, you authorise Unquit to read and change the Stripe objects described on the{" "}
          <Link href="/data-use" className="font-medium text-brand-text underline-offset-4 hover:underline">Data Use</Link> page,{" "}
          <strong>only on your behalf and only to run the features you set up</strong>: applying the offers in your cancel flow (coupons and
          discounts, pauses, plan changes), cancelling when your customer asks to cancel, and retrying or paying a failed invoice when your
          customer uses the card-update page. Unquit never moves money out of your Stripe account, never issues refunds and never changes
          your payout settings.
        </p>
        <p>
          You are responsible for the offers, emails and settings you configure, for the keys you create, and for keeping your Unquit
          password and widget signing secret private.
        </p>
      </Section>

      <Section title="4. Your customers">
        <p>
          The people who subscribe to your product are <strong>your customers</strong>, not ours. Unquit processes their data for you (see
          the Privacy Policy). You agree to:
        </p>
        <List>
          <li>have a lawful basis to send them service emails about failed payments, and tell them in your own privacy policy that you use a churn-recovery service;</li>
          <li>only make offers you are willing to honour;</li>
          <li>not use Unquit to mislead customers, make cancelling unreasonably hard, or break consumer-protection laws that apply to you.</li>
        </List>
        <p>
          Unquit always gives your customer a clear way to cancel in the cancel flow (“No thanks, cancel”). Please don’t try to work
          around it.
        </p>
      </Section>

      <Section id="fees" title="5. Fees">
        <p>There is <strong>no base fee</strong>. You pay only for saves Unquit can prove with a paid Stripe invoice:</p>
        <List>
          <li>
            <strong>Cancel save:</strong> 20% of the monthly recurring revenue you kept, for each of the first <strong>3 paid months</strong>{" "}
            after the customer accepted an offer. After that, that customer is free for good. Nothing is owed until their next invoice is
            actually paid.
          </li>
          <li>
            <strong>Failed-payment recovery:</strong> 10% of the amount recovered, charged <strong>once</strong>, when the invoice was paid
            through Unquit’s card-update page or Unquit’s retry. Payments Stripe recovers on its own are free.
          </li>
          <li>
            <strong>Monthly cap:</strong> you never pay more than <strong>$299 (USD)</strong> in a calendar month, however many saves there
            are.
          </li>
          <li>Fees are rounded down to the cent. Prices are in US dollars and don’t include any taxes that may apply to you.</li>
        </List>
        <p>
          A pending cancel save that isn’t followed by a paid invoice within 45 days, or whose customer cancels anyway, is marked lost and
          costs nothing.
        </p>
      </Section>

      <Section title="6. Receipts, disputes and clawbacks">
        <List>
          <li>
            <strong>Receipts.</strong> Every save has a receipt in your dashboard listing the Stripe invoice(s) that proved it, each fee
            month and any reversal.
          </li>
          <li>
            <strong>Disputes.</strong> If you think a save shouldn’t count, press “Dispute this save” on its receipt. Its fees are held
            straight away. Clear-cut cases (no paid invoice, a refund, the wrong subscription) are reversed automatically; anything else is
            reviewed by a person and you’ll get the outcome by email.
          </li>
          <li>
            <strong>Refunds.</strong> If you refund a saved customer or issue a credit note, the fee on that invoice is reversed in
            proportion. If it was already billed, it’s credited on your next statement.
          </li>
          <li>
            <strong>Chargebacks.</strong> While a customer disputes a payment with their bank, the fee on it is held. If you lose the
            chargeback, the fee is reversed.
          </li>
        </List>
      </Section>

      <Section title="7. Billing">
        <p>
          You add a billing card once under Dashboard → Billing. It is collected and stored by <strong>Dodo Payments</strong>, which acts
          as Unquit&apos;s <strong>merchant of record</strong> and reseller: Dodo Payments processes the payment, handles applicable sales tax
          or VAT, and appears on your card statement. Saving the card doesn&apos;t charge anything; it authorises Dodo Payments to charge
          Unquit&apos;s fees to it automatically.
        </p>
        <p>
          On the 1st of each month, Unquit closes your statement for the month before (itemised in your dashboard) and charges the total
          to your card automatically: fees after clawbacks, capped at $299, less any credit. A credit larger than a month&apos;s fees is
          carried forward to later statements; Unquit never pays out a negative balance. Totals under $1 are carried forward and added to the
          next charge. Months with nothing to pay get a statement and no charge.
        </p>
        <p>
          If a charge fails, we retry the same card up to three more times (about 3, 10 and 17 days later) unless the bank&apos;s decline
          means a retry can&apos;t succeed, and we email you so you can update your card. If it still can&apos;t be collected, the statement
          is marked unpaid and you&apos;ll be asked to add a new card, which is then charged once. Each charge&apos;s receipt is available from
          your billing page. Unquit may pause your features if a statement stays unpaid; we&apos;ll email you first.
        </p>
      </Section>

      <Section title="8. Fair use">
        <p>Please don’t:</p>
        <List>
          <li>use Unquit for anything illegal, or to send spam;</li>
          <li>try to access another founder’s data, probe or overload the service, or get around rate limits;</li>
          <li>connect a Stripe account you aren’t authorised to manage;</li>
          <li>reverse-engineer the service to avoid fees (for example, by recording saves in a way that hides them from Unquit).</li>
        </List>
        <p>We may suspend an account that does these things. Where we can, we’ll tell you first and explain why.</p>
      </Section>

      <Section title="9. An early-stage service">
        <p>
          Unquit is new and run by one person. We work hard to keep it running and correct, but we <strong>don’t offer a service-level
          agreement, uptime guarantee or certification</strong>. Features may change. If Unquit is unavailable, your Stripe account keeps
          working as normal: Stripe still bills, retries and emails your customers as you have set it up.
        </p>
        <p>
          Unquit is provided “as is”. To the extent the law allows, our total liability to you for anything related to Unquit is limited to
          the fees you paid Unquit in the 3 months before the claim, and we are not liable for indirect losses such as lost profits. Nothing
          here limits liability that can’t legally be limited.
        </p>
      </Section>

      <Section title="10. Ending things">
        <p>
          You can stop at any time: disconnect Stripe and remove the script from your app. You still owe fees for saves verified before you
          left, and clawbacks on those saves still apply in your favour. What happens to your data is explained in the Privacy Policy. We
          may close Unquit or your account with reasonable notice by email.
        </p>
      </Section>

      <Section title="11. Changes and law">
        <p>
          If we change these terms in a way that matters, we’ll update the date at the top and email account owners before the change
          applies. These terms are governed by the laws of India.
        </p>
      </Section>

      <Section title="12. Contact">
        <p>
          Questions, disputes or anything else: <Mail />.
        </p>
      </Section>
    </LegalPage>
  );
}
