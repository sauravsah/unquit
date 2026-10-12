import {
  CreditCard,
  FlaskConical,
  LayoutDashboard,
  Receipt,
  Settings,
  Wallet,
  Workflow,
  type LucideIcon,
} from "lucide-react";

export type NavItem = {
  href: string;
  label: string;
  /** Short label for the mobile bottom bar. */
  short: string;
  icon: LucideIcon;
  /** Second key of the "g then …" shortcut. */
  key: string;
  keywords?: string[];
};

/** The dashboard's pages, in sidebar order. Add new pages here and they appear in the sidebar, ⌘K and shortcuts. */
export const NAV: NavItem[] = [
  { href: "/dashboard", label: "Overview", short: "Overview", icon: LayoutDashboard, key: "o", keywords: ["home", "stats", "mrr"] },
  { href: "/dashboard/saves", label: "Saves & ledger", short: "Saves", icon: Receipt, key: "s", keywords: ["receipts", "ledger", "disputes"] },
  { href: "/dashboard/flows", label: "Cancel flows", short: "Flows", icon: Workflow, key: "f", keywords: ["offers", "survey", "widget"] },
  { href: "/dashboard/dunning", label: "Failed payments", short: "Dunning", icon: CreditCard, key: "p", keywords: ["dunning", "emails", "cards"] },
  { href: "/dashboard/billing", label: "Billing", short: "Billing", icon: Wallet, key: "b", keywords: ["invoice", "fees", "cap"] },
  { href: "/dashboard/test", label: "Test widget", short: "Test", icon: FlaskConical, key: "t", keywords: ["try", "sandbox"] },
  { href: "/dashboard/settings", label: "Settings", short: "Settings", icon: Settings, key: ",", keywords: ["keys", "stripe", "account", "theme"] },
];

/** Bottom-bar items on phones (the rest live in the "More" sheet). */
export const MOBILE_PRIMARY = ["/dashboard", "/dashboard/flows", "/dashboard/dunning", "/dashboard/saves"];

export function isActive(pathname: string, href: string): boolean {
  if (href === "/dashboard") return pathname === "/dashboard";
  return pathname === href || pathname.startsWith(`${href}/`);
}

/** "Overview", or ["Saves & ledger", "UQ-0001042"] for nested pages. */
export function breadcrumbFor(pathname: string): string[] {
  const item = [...NAV].sort((a, b) => b.href.length - a.href.length).find((n) => isActive(pathname, n.href) || pathname === n.href);
  if (!item) return ["Dashboard"];
  const rest = pathname.slice(item.href.length).split("/").filter(Boolean).map(decodeURIComponent);
  return [item.label, ...rest];
}

/** Cookie that remembers the collapsed sidebar, read on the server so the first paint is right. */
export const SIDEBAR_COOKIE = "uq-sidebar";
