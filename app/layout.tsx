import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "unquit — pay only for the customers we keep",
  description:
    "Cancel-flow offers and failed-payment recovery for Stripe. No base fee: you pay a share of the revenue we actually save.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen font-sans">{children}</body>
    </html>
  );
}
