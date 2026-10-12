"use client";

import { MotionConfig } from "framer-motion";
import { ThemeProvider as NextThemes } from "next-themes";
import { Toaster } from "@/components/ui/toast";
import { TooltipProvider } from "@/components/ui/tooltip";

/**
 * App-wide client providers: theme (follows the OS until the user picks one),
 * motion (honours prefers-reduced-motion everywhere), tooltips and toasts.
 */
export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <NextThemes attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
      <MotionConfig reducedMotion="user" transition={{ type: "spring", stiffness: 380, damping: 32 }}>
        <TooltipProvider delayDuration={250} skipDelayDuration={150}>
          {children}
          <Toaster />
        </TooltipProvider>
      </MotionConfig>
    </NextThemes>
  );
}
