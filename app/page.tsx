import dynamic from "next/dynamic";
import { Bento } from "@/components/marketing/Bento";
import { CtaBand, Footer } from "@/components/marketing/CtaFooter";
import { Faq } from "@/components/marketing/Faq";
import { Hero } from "@/components/marketing/Hero";
import { HowItWorks } from "@/components/marketing/HowItWorks";
import { MarketingNav } from "@/components/marketing/MarketingNav";

// Below the fold: its own chunk, still server-rendered (no layout shift, works for crawlers).
const PricingCalculator = dynamic(() => import("@/components/marketing/PricingCalculator").then((m) => m.PricingCalculator));

export default function LandingPage() {
  return (
    <div className="min-h-screen overflow-x-clip bg-background">
      <MarketingNav />
      <main>
        <Hero />
        <Bento />
        <HowItWorks />
        <PricingCalculator />
        <Faq />
        <CtaBand />
      </main>
      <Footer />
    </div>
  );
}
