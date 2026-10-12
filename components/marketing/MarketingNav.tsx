"use client";

import { motion, useMotionValueEvent, useScroll } from "framer-motion";
import { ArrowRight, Menu } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { Wordmark } from "@/components/Wordmark";
import { ThemeToggle } from "@/components/theme/ThemeToggle";
import { Button } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";
import { Sheet, SheetContent, SheetDescription, SheetTitle, SheetTrigger } from "@/components/ui/dialog";

const LINKS = [
  { href: "#features", label: "Features" },
  { href: "#how", label: "How it works" },
  { href: "#pricing", label: "Pricing" },
  { href: "#faq", label: "FAQ" },
];

/** Sticky glass nav that gains a border and shadow once you scroll. */
export function MarketingNav() {
  const { scrollY } = useScroll();
  const [scrolled, setScrolled] = useState(false);
  const [open, setOpen] = useState(false);
  useMotionValueEvent(scrollY, "change", (y) => setScrolled(y > 8));

  return (
    <header className="sticky top-0 z-50 px-3 pt-3 sm:px-4">
      <motion.nav
        aria-label="Main"
        className={cn(
          "mx-auto flex h-14 max-w-6xl items-center justify-between gap-4 rounded-2xl border px-3 transition-[background-color,border-color,box-shadow] duration-300 sm:px-4",
          scrolled ? "glass border-border shadow-lift" : "border-transparent bg-transparent",
        )}
      >
        <Wordmark />
        <ul className="hidden items-center gap-1 md:flex">
          {LINKS.map((l) => (
            <li key={l.href}>
              <a href={l.href} className="rounded-lg px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground">
                {l.label}
              </a>
            </li>
          ))}
        </ul>
        <div className="flex items-center gap-1.5">
          <ThemeToggle className="hidden sm:inline-flex" />
          <Button asChild variant="ghost" size="sm" className="hidden sm:inline-flex">
            <Link href="/login">Sign in</Link>
          </Button>
          <Button asChild variant="primary" size="sm" className="group">
            <Link href="/login">
              Get started <ArrowRight className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5" />
            </Link>
          </Button>
          <Sheet open={open} onOpenChange={setOpen}>
            <SheetTrigger asChild>
              <Button variant="ghost" size="icon" className="md:hidden" aria-label="Open menu">
                <Menu className="h-4 w-4" />
              </Button>
            </SheetTrigger>
            <SheetContent side="bottom" className="px-5 pb-8">
              <SheetTitle className="mt-4">Menu</SheetTitle>
              <SheetDescription className="sr-only">Site navigation</SheetDescription>
              <ul className="mt-4 divide-y divide-border">
                {LINKS.map((l) => (
                  <li key={l.href}>
                    <a href={l.href} onClick={() => setOpen(false)} className="block py-3.5 text-base font-medium text-foreground">
                      {l.label}
                    </a>
                  </li>
                ))}
              </ul>
              <div className="mt-6 flex items-center gap-2">
                <Button asChild variant="secondary" className="flex-1">
                  <Link href="/login">Sign in</Link>
                </Button>
                <ThemeToggle />
              </div>
            </SheetContent>
          </Sheet>
        </div>
      </motion.nav>
    </header>
  );
}
