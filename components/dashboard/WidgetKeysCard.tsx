"use client";

import { AnimatePresence, motion } from "framer-motion";
import { Check, Copy, Eye, EyeOff, KeyRound, RefreshCw } from "lucide-react";
import Link from "next/link";
import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { toast } from "@/components/ui/toast";
import { Tooltip } from "@/components/ui/tooltip";

/** Publishable key + signing secret with copy, reveal and a confirmed rotate (posts to the existing route). */
export function WidgetKeysCard({ publishableKey, signingSecret }: { publishableKey: string; signingSecret: string }) {
  const [revealed, setRevealed] = useState(false);
  const [rotating, setRotating] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);

  return (
    <section className="rounded-xl border border-border bg-card shadow-card" aria-labelledby="keys-title">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border px-5 py-4">
        <div className="flex items-start gap-3">
          <span className="mt-0.5 flex h-8 w-8 items-center justify-center rounded-lg border border-border bg-muted">
            <KeyRound className="h-4 w-4 text-muted-foreground" />
          </span>
          <div>
            <h2 id="keys-title" className="text-sm font-semibold text-foreground">
              Widget keys
            </h2>
            <p className="mt-0.5 max-w-xl text-xs text-muted-foreground">
              Put the publishable key in the script tag. Keep the signing secret on your server: it signs each customer so nobody can
              open the cancel flow for someone else.
            </p>
          </div>
        </div>
        <Button asChild variant="secondary" size="sm">
          <Link href="/dashboard/test">Test the widget</Link>
        </Button>
      </div>
      <dl className="grid gap-5 p-5 text-sm md:grid-cols-2">
        <div>
          <dt className="text-2xs font-medium uppercase tracking-wider text-muted-foreground">Publishable key · public</dt>
          <dd className="mt-1.5">
            <KeyField value={publishableKey} label="publishable key" />
          </dd>
        </div>
        <div>
          <dt className="text-2xs font-medium uppercase tracking-wider text-muted-foreground">Signing secret · server only</dt>
          <dd className="mt-1.5 space-y-2">
            <KeyField
              value={signingSecret}
              label="signing secret"
              masked={!revealed}
              extra={
                <Tooltip content={revealed ? "Hide" : "Reveal"}>
                  <Button variant="ghost" size="icon-sm" onClick={() => setRevealed((r) => !r)} aria-label={revealed ? "Hide secret" : "Reveal secret"}>
                    {revealed ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                  </Button>
                </Tooltip>
              }
            />
            <Dialog>
              <DialogTrigger asChild>
                <button type="button" className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground underline-offset-4 hover:text-foreground hover:underline">
                  <RefreshCw className="h-3 w-3" /> Rotate secret
                </button>
              </DialogTrigger>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>Rotate the signing secret?</DialogTitle>
                  <DialogDescription>
                    Signatures made with the current secret stop working immediately. Update your server with the new one at the same time.
                  </DialogDescription>
                </DialogHeader>
                <form ref={formRef} action="/api/dashboard/rotate-secret" method="post" onSubmit={() => setRotating(true)} className="flex justify-end gap-2">
                  <DialogClose asChild>
                    <Button type="button" variant="secondary">
                      Cancel
                    </Button>
                  </DialogClose>
                  <Button type="submit" variant="danger" loading={rotating}>
                    Rotate secret
                  </Button>
                </form>
              </DialogContent>
            </Dialog>
          </dd>
        </div>
      </dl>
    </section>
  );
}

function KeyField({ value, label, masked = false, extra }: { value: string; label: string; masked?: boolean; extra?: React.ReactNode }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      toast.success(`Copied the ${label}`);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      toast.error("Couldn't copy. Select the text and copy it instead.");
    }
  }
  return (
    <div className="flex items-center gap-1 rounded-lg border border-border bg-muted/50 py-1 pl-3 pr-1">
      <code className="min-w-0 flex-1 truncate font-mono text-xs text-foreground" title={masked ? undefined : value}>
        {masked ? `${value.slice(0, 5)}${"•".repeat(24)}` : value}
      </code>
      {extra}
      <Tooltip content={copied ? "Copied" : "Copy"}>
        <Button variant="ghost" size="icon-sm" onClick={copy} aria-label={`Copy ${label}`}>
          <AnimatePresence mode="wait" initial={false}>
            <motion.span key={copied ? "y" : "n"} initial={{ scale: 0.5, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.5, opacity: 0 }} className="flex">
              {copied ? <Check className="h-3.5 w-3.5 text-brand-text" /> : <Copy className="h-3.5 w-3.5" />}
            </motion.span>
          </AnimatePresence>
        </Button>
      </Tooltip>
    </div>
  );
}
