import type { Metadata, Viewport } from "next";
import Script from "next/script";
import { GeistMono } from "geist/font/mono";
import { GeistSans } from "geist/font/sans";
import { AnalyticsScope } from "@/components/analytics/AnalyticsScope";
import { Providers } from "@/components/theme/ThemeProvider";
import { ANALYTICS_PATHS, GA_MEASUREMENT_ID } from "@/lib/analytics";
import "./globals.css";

export const metadata: Metadata = {
  title: "unquit — pay only for the customers we keep",
  description:
    "Cancel-flow offers and failed-payment recovery for Stripe. No base fee: you pay a share of the revenue we actually save.",
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
    { media: "(prefers-color-scheme: dark)", color: "#09090b" },
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    // suppressHydrationWarning: next-themes sets the theme class before React hydrates.
    <html lang="en" suppressHydrationWarning className={`${GeistSans.variable} ${GeistMono.variable}`}>
      <body className="min-h-screen font-sans">
        <Script src={`https://www.googletagmanager.com/gtag/js?id=${GA_MEASUREMENT_ID}`} strategy="afterInteractive" />
        <Script id="google-analytics" strategy="afterInteractive">
          {`window.dataLayer = window.dataLayer || [];
function gtag(){dataLayer.push(arguments);}
var uqPath = location.pathname;
while (uqPath.length > 1 && uqPath.charAt(uqPath.length - 1) === '/') uqPath = uqPath.slice(0, -1);
// Analytics only on public pages: never on the dashboard, card-update pages (/u/) or setup links (/install/).
if (${JSON.stringify(ANALYTICS_PATHS)}.indexOf(uqPath) === -1) { window['ga-disable-${GA_MEASUREMENT_ID}'] = true; }
gtag('js', new Date());
gtag('config', '${GA_MEASUREMENT_ID}');`}
        </Script>
        <AnalyticsScope />
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
