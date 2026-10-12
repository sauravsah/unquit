"use client";

import { Reveal } from "@/components/motion";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";

const FAQ = [
  {
    q: "What exactly counts as a save?",
    a: "A cancel save is a customer who accepted an offer in the cancel flow and then paid their next invoice (more than $0). Until that invoice is paid, the save is pending and costs nothing. A dunning save is a failed invoice paid through unquit's retry or card-update link.",
  },
  {
    q: "What if Stripe recovers the payment on its own?",
    a: "Then it's free. Recoveries by Stripe's Smart Retries or any other route are marked external and never billed.",
  },
  {
    q: "How is the fee calculated?",
    a: "20% of the saved MRR for each of the first 3 months the customer keeps paying, and 10% of any failed payment we recover. There's no base fee, and a calendar month never costs more than $299.",
  },
  {
    q: "What happens if a saved customer gets refunded?",
    a: "If the end customer is refunded inside the dispute window, the fee for that save is clawed back automatically. Every save also has a receipt with a Dispute button.",
  },
  {
    q: "Does it work with my stack?",
    a: "If you bill with Stripe subscriptions, yes. The widget is a framework-free script that lives in a shadow DOM, so it won't clash with your CSS. You sign each customer on your server with an HMAC, so nobody can open the flow for someone else.",
  },
  {
    q: "Can I try it before going live?",
    a: "Yes. Connect a Stripe test-mode account and use Test the widget in the dashboard to run the real flow against a test customer.",
  },
];

export function Faq() {
  return (
    <section id="faq" className="container scroll-mt-24 py-24">
      <div className="grid gap-12 lg:grid-cols-[1fr_1.6fr]">
        <Reveal>
          <p className="text-sm font-medium text-brand-text">FAQ</p>
          <h2 className="mt-3 text-4xl font-semibold tracking-tight text-foreground">Questions founders ask</h2>
          <p className="mt-4 text-muted-foreground">Anything else? Sign in and the dashboard walks you through it.</p>
        </Reveal>
        <Reveal delay={0.05}>
          <Accordion type="single" collapsible className="border-t border-border">
            {FAQ.map((item, i) => (
              <AccordionItem key={item.q} value={`q${i}`}>
                <AccordionTrigger>{item.q}</AccordionTrigger>
                <AccordionContent>{item.a}</AccordionContent>
              </AccordionItem>
            ))}
          </Accordion>
        </Reveal>
      </div>
    </section>
  );
}
