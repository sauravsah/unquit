"use client";

import { RefreshCw, Send } from "lucide-react";
import { useState } from "react";
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
import { CopyButton } from "./CodeBlock";

/** "Send to my developer": the public setup link, a ready message, and a rotate-link action. */
export function ShareCard({ link, message }: { link: string; message: string }) {
  const [rotating, setRotating] = useState(false);
  return (
    <section className="overflow-hidden rounded-xl border border-border bg-card shadow-card" aria-labelledby="share-title">
      <div className="relative border-b border-border px-5 py-4">
        <div aria-hidden="true" className="pointer-events-none absolute -right-16 -top-20 h-40 w-64 rounded-full bg-brand/15 blur-3xl" />
        <div className="relative flex items-start gap-3">
          <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-border bg-muted">
            <Send className="h-4 w-4 text-brand-text" />
          </span>
          <div>
            <h2 id="share-title" className="text-sm font-semibold text-foreground">
              Send to my developer
            </h2>
            <p className="mt-0.5 max-w-xl text-xs text-muted-foreground">
              This link opens the developer instructions below, with your publishable key filled in. No login needed, and it never shows
              your signing secret or any of your dashboard data.
            </p>
          </div>
        </div>
      </div>
      <div className="space-y-5 p-5">
        <div>
          <p className="text-2xs font-medium uppercase tracking-wider text-muted-foreground">Setup link</p>
          <div className="mt-1.5 flex items-center gap-1 rounded-lg border border-border bg-muted/50 py-1 pl-3 pr-1">
            <code className="min-w-0 flex-1 truncate font-mono text-xs text-foreground" title={link}>
              {link}
            </code>
            <CopyButton text={link} what="the setup link" label="Copy link" />
          </div>
        </div>
        <div>
          <div className="flex items-center justify-between gap-3">
            <p className="text-2xs font-medium uppercase tracking-wider text-muted-foreground">Message to paste in Slack or email</p>
            <CopyButton text={message} what="the message" label="Copy message" variant="secondary" />
          </div>
          <p className="mt-1.5 whitespace-pre-line rounded-lg border border-border bg-muted/40 p-3 text-xs leading-relaxed text-foreground">{message}</p>
          <p className="mt-2 text-xs text-muted-foreground">
            Then send the signing secret on its own, through a password manager or a direct message.
          </p>
        </div>
        <Dialog>
          <DialogTrigger asChild>
            <button
              type="button"
              className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
            >
              <RefreshCw className="h-3 w-3" /> Make a new link
            </button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Make a new setup link?</DialogTitle>
              <DialogDescription>
                The current link stops working at once. Use this if you shared it with the wrong person. Your keys don&apos;t change, and
                nothing in your app breaks.
              </DialogDescription>
            </DialogHeader>
            <form action="/api/dashboard/rotate-install-link" method="post" onSubmit={() => setRotating(true)} className="flex justify-end gap-2">
              <DialogClose asChild>
                <Button type="button" variant="secondary">
                  Cancel
                </Button>
              </DialogClose>
              <Button type="submit" variant="primary" loading={rotating}>
                Make a new link
              </Button>
            </form>
          </DialogContent>
        </Dialog>
      </div>
    </section>
  );
}
