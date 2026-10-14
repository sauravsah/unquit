"use client";

import { AnimatePresence, motion } from "framer-motion";
import { Check, Copy } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";
import { toast } from "@/components/ui/toast";

/** Copies text, with a toast either way. Returns true on success. */
export async function copyText(text: string, what: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    toast.success(`Copied ${what}`);
    return true;
  } catch {
    toast.error("Couldn't copy. Select the text and copy it instead.");
    return false;
  }
}

export function CopyButton({
  text,
  what,
  label = "Copy",
  variant = "ghost",
  className,
}: {
  text: string;
  what: string;
  label?: string;
  variant?: "ghost" | "secondary" | "primary" | "brand";
  className?: string;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      type="button"
      variant={variant}
      size="sm"
      className={cn("gap-1.5", className)}
      onClick={async () => {
        if (await copyText(text, what)) {
          setCopied(true);
          setTimeout(() => setCopied(false), 1600);
        }
      }}
      aria-label={`Copy ${what}`}
    >
      <AnimatePresence mode="wait" initial={false}>
        <motion.span
          key={copied ? "y" : "n"}
          initial={{ scale: 0.5, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          exit={{ scale: 0.5, opacity: 0 }}
          className="flex"
        >
          {copied ? <Check className="h-3.5 w-3.5 text-brand-text" /> : <Copy className="h-3.5 w-3.5" />}
        </motion.span>
      </AnimatePresence>
      {copied ? "Copied" : label}
    </Button>
  );
}

/** A dark code panel (same in both themes) with a filename bar and a copy button. */
export function CodeBlock({ code, title, filename, className }: { code: string; title: string; filename?: string; className?: string }) {
  return (
    <div className={cn("overflow-hidden rounded-xl border border-border bg-zinc-950 shadow-xs dark:border-zinc-800", className)}>
      <div className="flex items-center justify-between gap-3 border-b border-zinc-800 py-1 pl-4 pr-1.5">
        <span className="truncate font-mono text-2xs text-zinc-400">{filename ?? title}</span>
        <CopyButton text={code} what={title.toLowerCase()} className="text-zinc-300 hover:bg-zinc-800 hover:text-zinc-50" />
      </div>
      <pre className="overflow-x-auto p-4 text-xs leading-relaxed text-zinc-100">
        <code className="font-mono">{code}</code>
      </pre>
    </div>
  );
}
