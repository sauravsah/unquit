"use client";

import { motion } from "framer-motion";
import { ChevronsLeft, LogOut, Menu, Search, Settings, Keyboard, ChevronRight } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useTheme } from "next-themes";
import { useCallback, useEffect, useRef, useState } from "react";
import { ThemeToggle } from "@/components/theme/ThemeToggle";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/dialog";
import { Kbd } from "@/components/ui/input";
import { Tooltip } from "@/components/ui/tooltip";
import { CommandPalette } from "./CommandPalette";
import { MOBILE_PRIMARY, NAV, SIDEBAR_COOKIE, breadcrumbFor, isActive } from "./nav";
import { SHORTCUTS, useShortcuts } from "./shortcuts";



/**
 * The /dashboard frame: collapsible sidebar, glass top bar with breadcrumb,
 * ⌘K palette, "?" shortcuts sheet and a bottom nav on phones.
 */
export function AppShell({
  email,
  livemode,
  connected,
  initialCollapsed,
  children,
}: {
  email: string | undefined;
  livemode: boolean | null;
  connected: boolean;
  initialCollapsed: boolean;
  children: React.ReactNode;
}) {
  const router = useRouter();
  const pathname = usePathname() ?? "/dashboard";
  const { resolvedTheme, setTheme } = useTheme();
  const [collapsed, setCollapsed] = useState(initialCollapsed);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const signOutRef = useRef<HTMLFormElement>(null);

  const toggleSidebar = useCallback(() => {
    setCollapsed((c) => {
      const next = !c;
      document.cookie = `${SIDEBAR_COOKIE}=${next ? "collapsed" : "expanded"}; path=/; max-age=31536000; samesite=lax`;
      return next;
    });
  }, []);
  const toggleTheme = useCallback(() => setTheme(resolvedTheme === "dark" ? "light" : "dark"), [resolvedTheme, setTheme]);
  const signOut = useCallback(() => signOutRef.current?.requestSubmit(), []);

  useShortcuts({
    palette: () => setPaletteOpen((o) => !o),
    help: () => setHelpOpen(true),
    sidebar: toggleSidebar,
    theme: toggleTheme,
    go: (key) => {
      const item = NAV.find((n) => n.key === key);
      if (!item) return false;
      router.push(item.href);
      return true;
    },
  });

  // Prefetch every page so switching feels instant.
  useEffect(() => {
    NAV.forEach((n) => router.prefetch(n.href));
  }, [router]);

  useEffect(() => setMoreOpen(false), [pathname]);

  const crumbs = breadcrumbFor(pathname);
  const width = collapsed ? 64 : 240;

  return (
    <div className="min-h-screen bg-surface">
      <form ref={signOutRef} action="/auth/signout" method="post" className="hidden" aria-hidden="true" />
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-[60] focus:rounded-md focus:bg-foreground focus:px-3 focus:py-2 focus:text-sm focus:text-background"
      >
        Skip to content
      </a>

      {/* Sidebar (tablet / desktop) */}
      <motion.aside
        initial={false}
        animate={{ width }}
        transition={{ type: "spring", stiffness: 420, damping: 40 }}
        className="fixed inset-y-0 left-0 z-40 hidden flex-col border-r border-border bg-background print:!hidden md:flex"
        aria-label="Sidebar"
      >
        <div className={cn("flex h-14 items-center border-b border-border", collapsed ? "justify-center px-0" : "justify-between px-4")}>
          <Link href="/dashboard" className="flex items-center gap-2 rounded-md text-foreground" aria-label="unquit, overview">
            <LogoMark />
            {collapsed ? null : (
              <span className="text-[15px] font-semibold tracking-tight">
                unquit<span className="text-brand">.</span>
              </span>
            )}
          </Link>
          {collapsed ? null : (
            <Tooltip content={<span className="flex items-center gap-2">Collapse <Kbd className="h-4 border-background/20 bg-background/10 text-background">[</Kbd></span>}>
              <Button variant="ghost" size="icon-sm" onClick={toggleSidebar} aria-label="Collapse sidebar">
                <ChevronsLeft className="h-4 w-4" />
              </Button>
            </Tooltip>
          )}
        </div>

        <nav className="flex-1 space-y-0.5 overflow-y-auto p-2" aria-label="Dashboard">
          {NAV.map((item) => {
            const active = isActive(pathname, item.href);
            const Icon = item.icon;
            return (
              <Tooltip key={item.href} content={item.label} side="right" disabled={!collapsed}>
                <Link
                  href={item.href}
                  aria-current={active ? "page" : undefined}
                  aria-label={collapsed ? item.label : undefined}
                  className={cn(
                    "group relative flex h-9 items-center gap-3 rounded-lg text-sm font-medium transition-colors",
                    collapsed ? "justify-center px-0" : "px-3",
                    active ? "text-foreground" : "text-muted-foreground hover:bg-muted/70 hover:text-foreground",
                  )}
                >
                  {active ? (
                    <motion.span
                      layoutId="sidebar-active"
                      className="absolute inset-0 rounded-lg border border-border bg-muted shadow-xs"
                      transition={{ type: "spring", stiffness: 500, damping: 40 }}
                    />
                  ) : null}
                  {active ? <span className="absolute -left-2 top-2 h-5 w-[3px] rounded-r-full bg-brand shadow-glow-sm" /> : null}
                  <Icon className={cn("relative h-4 w-4 shrink-0", active && "text-brand-text")} />
                  {collapsed ? null : <span className="relative truncate">{item.label}</span>}
                </Link>
              </Tooltip>
            );
          })}
        </nav>

        <div className="space-y-2 border-t border-border p-2">
          {collapsed ? (
            <Tooltip content="Expand sidebar" side="right">
              <Button variant="ghost" size="icon" className="w-full" onClick={toggleSidebar} aria-label="Expand sidebar">
                <ChevronsLeft className="h-4 w-4 rotate-180" />
              </Button>
            </Tooltip>
          ) : (
            <button
              type="button"
              onClick={() => setHelpOpen(true)}
              className="flex w-full items-center justify-between rounded-lg px-3 py-2 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              <span className="flex items-center gap-2">
                <Keyboard className="h-3.5 w-3.5" /> Shortcuts
              </span>
              <Kbd>?</Kbd>
            </button>
          )}
        </div>
      </motion.aside>

      <div
        className="flex min-h-screen flex-col transition-[padding] duration-300 ease-spring md:pl-[var(--sidebar-w)] print:!pl-0"
        style={{ ["--sidebar-w" as string]: `${width}px` }}
      >
        {/* Top bar */}
        <header className="glass sticky top-0 z-30 flex h-14 items-center gap-3 border-b px-4 print:hidden sm:px-6">
          <Link href="/dashboard" className="flex items-center gap-2 md:hidden" aria-label="unquit, overview">
            <LogoMark />
          </Link>
          <nav aria-label="Breadcrumb" className="min-w-0 flex-1">
            <ol className="flex min-w-0 items-center gap-1.5 text-sm">
              <li className="hidden text-muted-foreground sm:block">
                <Link href="/dashboard" className="hover:text-foreground">
                  Dashboard
                </Link>
              </li>
              {crumbs.map((c, i) => (
                <li key={`${c}-${i}`} className="flex min-w-0 items-center gap-1.5">
                  <ChevronRight className={cn("h-3.5 w-3.5 shrink-0 text-subtle", i === 0 && "hidden sm:block")} aria-hidden="true" />
                  <span
                    className={cn("truncate", i === crumbs.length - 1 ? "font-medium text-foreground" : "text-muted-foreground")}
                    aria-current={i === crumbs.length - 1 ? "page" : undefined}
                  >
                    {c}
                  </span>
                </li>
              ))}
              {livemode === false && connected ? (
                <li className="ml-1 hidden sm:block">
                  <Badge tone="warning" dot>
                    Test mode
                  </Badge>
                </li>
              ) : null}
            </ol>
          </nav>

          <button
            type="button"
            onClick={() => setPaletteOpen(true)}
            className="hidden h-8 w-56 items-center gap-2 rounded-lg border border-border bg-card/60 px-2.5 text-sm text-muted-foreground shadow-xs transition-colors hover:border-input hover:text-foreground lg:flex"
          >
            <Search className="h-3.5 w-3.5" />
            <span className="flex-1 text-left">Search or jump to…</span>
            <Kbd>⌘K</Kbd>
          </button>
          <Button variant="ghost" size="icon" className="lg:hidden" onClick={() => setPaletteOpen(true)} aria-label="Open command palette">
            <Search className="h-4 w-4" />
          </Button>
          <ThemeToggle />
          <UserMenu email={email} onHelp={() => setHelpOpen(true)} onSignOut={signOut} />
        </header>

        <main id="main" className="mx-auto w-full max-w-6xl flex-1 px-4 pb-28 pt-6 sm:px-6 md:pb-12 md:pt-8">
          {children}
        </main>
      </div>

      {/* Bottom nav (phones) */}
      <nav
        aria-label="Dashboard"
        className="glass fixed inset-x-0 bottom-0 z-40 flex items-stretch justify-around border-t pb-[env(safe-area-inset-bottom)] print:hidden md:hidden"
      >
        {NAV.filter((n) => MOBILE_PRIMARY.includes(n.href)).map((item) => {
          const active = isActive(pathname, item.href);
          const Icon = item.icon;
          return (
            <Link
              key={item.href}
              href={item.href}
              aria-current={active ? "page" : undefined}
              className={cn(
                "relative flex min-h-[56px] flex-1 flex-col items-center justify-center gap-1 text-2xs font-medium",
                active ? "text-foreground" : "text-muted-foreground",
              )}
            >
              {active ? <motion.span layoutId="mobile-active" className="absolute top-0 h-0.5 w-8 rounded-full bg-brand shadow-glow-sm" /> : null}
              <Icon className={cn("h-5 w-5", active && "text-brand-text")} />
              {item.short}
            </Link>
          );
        })}
        <button
          type="button"
          onClick={() => setMoreOpen(true)}
          className="flex min-h-[56px] flex-1 flex-col items-center justify-center gap-1 text-2xs font-medium text-muted-foreground"
        >
          <Menu className="h-5 w-5" />
          More
        </button>
      </nav>

      <Sheet open={moreOpen} onOpenChange={setMoreOpen}>
        <SheetContent side="bottom" className="px-4 pb-6">
          <SheetTitle className="mt-4 px-1">Menu</SheetTitle>
          <SheetDescription className="px-1">Every page and a few quick actions.</SheetDescription>
          <div className="mt-4 grid grid-cols-3 gap-2">
            {NAV.map((item) => {
              const Icon = item.icon;
              const active = isActive(pathname, item.href);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={cn(
                    "flex flex-col items-center gap-2 rounded-xl border p-3 text-center text-xs font-medium transition-colors",
                    active ? "border-brand/40 bg-brand-soft text-foreground" : "border-border bg-card text-muted-foreground",
                  )}
                >
                  <Icon className={cn("h-5 w-5", active && "text-brand-text")} />
                  {item.short}
                </Link>
              );
            })}
          </div>
          <div className="mt-4 flex gap-2">
            <Button variant="secondary" className="flex-1" onClick={toggleTheme}>
              Toggle theme
            </Button>
            <Button variant="secondary" className="flex-1" onClick={signOut}>
              <LogOut className="h-4 w-4" /> Sign out
            </Button>
          </div>
        </SheetContent>
      </Sheet>

      <CommandPalette
        open={paletteOpen}
        onOpenChange={setPaletteOpen}
        connected={connected}
        onToggleTheme={toggleTheme}
        onToggleSidebar={toggleSidebar}
        onHelp={() => setHelpOpen(true)}
        onSignOut={signOut}
      />

      <Sheet open={helpOpen} onOpenChange={setHelpOpen}>
        <SheetContent side="right" className="p-6">
          <SheetTitle>Keyboard shortcuts</SheetTitle>
          <SheetDescription>Work without leaving the keyboard.</SheetDescription>
          <ul className="mt-6 divide-y divide-border">
            {SHORTCUTS.map((s) => (
              <li key={s.label} className="flex items-center justify-between gap-4 py-2.5 text-sm">
                <span className="text-foreground">{s.label}</span>
                <span className="flex shrink-0 items-center gap-1">
                  {s.keys.map((k, i) => (
                    <span key={k + i} className="flex items-center gap-1">
                      {i > 0 && s.keys[0] === "G" ? <span className="text-2xs text-subtle">then</span> : null}
                      <Kbd>{k}</Kbd>
                    </span>
                  ))}
                </span>
              </li>
            ))}
          </ul>
        </SheetContent>
      </Sheet>
    </div>
  );
}

function UserMenu({ email, onHelp, onSignOut }: { email: string | undefined; onHelp: () => void; onSignOut: () => void }) {
  const initials = (email ?? "?").slice(0, 2).toUpperCase();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label="Account menu"
          className="flex h-8 w-8 items-center justify-center rounded-full bg-gradient-to-br from-brand to-emerald-700 text-2xs font-semibold text-white shadow-glow-sm ring-2 ring-background transition-transform hover:scale-105 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {initials}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-60">
        <DropdownMenuLabel className="normal-case tracking-normal">
          <span className="block text-2xs uppercase tracking-wider">Signed in as</span>
          <span className="mt-0.5 block truncate text-sm font-medium text-foreground">{email ?? "—"}</span>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link href="/dashboard/settings">
            <Settings /> Settings
          </Link>
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={onHelp}>
          <Keyboard /> Keyboard shortcuts
          <Kbd className="ml-auto">?</Kbd>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem destructive onSelect={onSignOut}>
          <LogOut /> Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The square brand mark: a green "u" with a soft glow. */
export function LogoMark({ className }: { className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "relative flex h-7 w-7 items-center justify-center rounded-lg bg-foreground text-background shadow-inner-hi",
        className,
      )}
    >
      <svg viewBox="0 0 20 20" className="h-4 w-4">
        <path d="M5 5v5.5a5 5 0 0 0 10 0V5" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
        <circle cx="15.5" cy="15.5" r="2" className="fill-brand-glow" />
      </svg>
    </span>
  );
}
