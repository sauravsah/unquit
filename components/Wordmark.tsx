import Link from "next/link";
import { cn } from "@/components/ui/cn";

/** The lowercase "unquit" wordmark. The green dot is the only brand flourish. */
export function Wordmark({ href = "/", className = "" }: { href?: string; className?: string }) {
  return (
    <Link
      href={href}
      className={cn("inline-flex items-center gap-2 text-lg font-semibold tracking-tight text-foreground", className)}
    >
      <span aria-hidden="true" className="flex h-7 w-7 items-center justify-center rounded-lg bg-foreground text-background shadow-inner-hi">
        <svg viewBox="0 0 20 20" className="h-4 w-4">
          <path d="M5 5v5.5a5 5 0 0 0 10 0V5" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
          <circle cx="15.5" cy="15.5" r="2" fill="#22C55E" />
        </svg>
      </span>
      <span>
        unquit<span className="text-brand">.</span>
      </span>
    </Link>
  );
}
