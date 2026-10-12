"use client";

import { Command } from "cmdk";
import { ArrowRight, ExternalLink, Keyboard, LogOut, PanelLeft, Plug, SunMoon } from "lucide-react";
import { useRouter } from "next/navigation";
import { Kbd } from "@/components/ui/input";
import { NAV } from "./nav";

/** ⌘K: jump to any page or run an action. Built on cmdk (which uses Radix Dialog for focus and Escape). */
export function CommandPalette({
  open,
  onOpenChange,
  connected,
  onToggleTheme,
  onToggleSidebar,
  onHelp,
  onSignOut,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  connected: boolean;
  onToggleTheme: () => void;
  onToggleSidebar: () => void;
  onHelp: () => void;
  onSignOut: () => void;
}) {
  const router = useRouter();
  const run = (fn: () => void) => () => {
    onOpenChange(false);
    // Let the dialog close before navigating or opening another sheet.
    requestAnimationFrame(fn);
  };

  return (
    <Command.Dialog
      open={open}
      onOpenChange={onOpenChange}
      label="Command palette"
      loop
      overlayClassName="fixed inset-0 z-50 bg-black/40 backdrop-blur-[2px] animate-fade-in"
      contentClassName="fixed left-1/2 top-[14vh] z-50 w-[calc(100%-2rem)] max-w-xl -translate-x-1/2 overflow-hidden rounded-2xl border border-border bg-popover text-popover-foreground shadow-float animate-palette-in"
    >
      <div className="flex items-center gap-2 border-b border-border px-4">
        <svg aria-hidden="true" viewBox="0 0 20 20" className="h-4 w-4 text-muted-foreground">
          <circle cx="9" cy="9" r="6" fill="none" stroke="currentColor" strokeWidth="1.6" />
          <path d="m14 14 3.5 3.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
        <Command.Input
          autoFocus
          placeholder="Type a command or search…"
          className="h-12 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-subtle"
        />
        <Kbd>Esc</Kbd>
      </div>
      <Command.List className="max-h-[min(60vh,420px)] overflow-y-auto overscroll-contain p-2 [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:pb-1.5 [&_[cmdk-group-heading]]:pt-2 [&_[cmdk-group-heading]]:text-2xs [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wider [&_[cmdk-group-heading]]:text-muted-foreground">
        <Command.Empty className="py-10 text-center text-sm text-muted-foreground">No results. Try “flows” or “theme”.</Command.Empty>

        <Command.Group heading="Go to">
          {NAV.map((item) => {
            const Icon = item.icon;
            return (
              <Item key={item.href} value={`${item.label} ${item.keywords?.join(" ") ?? ""}`} onSelect={run(() => router.push(item.href))}>
                <Icon className="h-4 w-4 text-muted-foreground" />
                <span className="flex-1">{item.label}</span>
                <span className="flex items-center gap-1">
                  <Kbd>G</Kbd>
                  <Kbd>{item.key.toUpperCase()}</Kbd>
                </span>
              </Item>
            );
          })}
        </Command.Group>

        <Command.Group heading="Actions">
          {!connected ? (
            <Item value="connect stripe account" onSelect={run(() => (window.location.href = "/api/stripe/connect"))}>
              <Plug className="h-4 w-4 text-brand-text" />
              <span className="flex-1">Connect Stripe</span>
              <ArrowRight className="h-3.5 w-3.5 text-muted-foreground" />
            </Item>
          ) : null}
          <Item value="toggle theme dark light mode" onSelect={run(onToggleTheme)}>
            <SunMoon className="h-4 w-4 text-muted-foreground" />
            <span className="flex-1">Toggle light / dark</span>
            <span className="flex items-center gap-1">
              <Kbd>⇧</Kbd>
              <Kbd>D</Kbd>
            </span>
          </Item>
          <Item value="collapse expand sidebar" onSelect={run(onToggleSidebar)}>
            <PanelLeft className="h-4 w-4 text-muted-foreground" />
            <span className="flex-1">Collapse / expand sidebar</span>
            <Kbd>[</Kbd>
          </Item>
          <Item value="keyboard shortcuts help" onSelect={run(onHelp)}>
            <Keyboard className="h-4 w-4 text-muted-foreground" />
            <span className="flex-1">Keyboard shortcuts</span>
            <Kbd>?</Kbd>
          </Item>
          <Item value="open website landing page" onSelect={run(() => window.open("/", "_blank", "noopener"))}>
            <ExternalLink className="h-4 w-4 text-muted-foreground" />
            <span className="flex-1">Open the website</span>
          </Item>
          <Item value="sign out log out" onSelect={run(onSignOut)}>
            <LogOut className="h-4 w-4 text-muted-foreground" />
            <span className="flex-1">Sign out</span>
          </Item>
        </Command.Group>
      </Command.List>
      <div className="flex items-center justify-between border-t border-border bg-muted/40 px-4 py-2 text-2xs text-muted-foreground">
        <span className="flex items-center gap-1.5">
          <Kbd>↑</Kbd>
          <Kbd>↓</Kbd> to move <Kbd>↵</Kbd> to select
        </span>
        <span>
          unquit<span className="text-brand">.</span>
        </span>
      </div>
    </Command.Dialog>
  );
}

function Item({ children, value, onSelect }: { children: React.ReactNode; value: string; onSelect: () => void }) {
  return (
    <Command.Item
      value={value}
      onSelect={onSelect}
      className="flex cursor-pointer items-center gap-3 rounded-lg px-2 py-2 text-sm text-foreground outline-none transition-colors data-[selected=true]:bg-muted"
    >
      {children}
    </Command.Item>
  );
}
