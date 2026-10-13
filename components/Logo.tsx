import Link from "next/link";
import { cn } from "@/components/ui/cn";

/**
 * The unquit mark: a "u" drawn as a U-turn arrow. The stroke heads down (a
 * customer on the way out), turns, and comes back up higher than it started,
 * in brand green. The left leg follows the text colour, so the mark works on
 * light and dark backgrounds; the arrow is always green.
 */
export function LogoMark({ className, title }: { className?: string; title?: string }) {
  return (
    <svg
      viewBox="0 0 32 32"
      fill="none"
      className={cn("h-7 w-7 shrink-0", className)}
      role={title ? "img" : undefined}
      aria-hidden={title ? undefined : true}
      aria-label={title}
    >
      <g transform="translate(-1.4 1.3)">
        <path d="M7.5 8.5V17.5a7.5 7.5 0 0 0 7.5 7.5" stroke="currentColor" strokeWidth="4.5" strokeLinecap="round" />
        <path d="M15 25a7.5 7.5 0 0 0 7.5-7.5V11" className="stroke-brand dark:stroke-brand-glow" strokeWidth="4.5" />
        <path
          d="M22.5 2.25 29 11.25H16Z"
          className="fill-brand stroke-brand dark:fill-brand-glow dark:stroke-brand-glow"
          strokeWidth="1.25"
          strokeLinejoin="round"
        />
      </g>
    </svg>
  );
}

/** Mark + the lowercase "unquit." wordmark. Pass `href={null}` to render without a link. */
export function Logo({
  href = "/",
  className,
  markClassName,
}: {
  href?: string | null;
  className?: string;
  markClassName?: string;
}) {
  const content = (
    <>
      <LogoMark className={markClassName} />
      <span className="-ml-0.5">
        unquit<span className="text-brand dark:text-brand-glow">.</span>
      </span>
    </>
  );
  const cls = cn("inline-flex items-center gap-1.5 text-lg font-semibold tracking-[-0.03em] text-foreground", className);
  if (href === null) {
    return (
      <span className={cls} aria-label="unquit">
        {content}
      </span>
    );
  }
  return (
    <Link href={href} className={cls} aria-label="unquit home">
      {content}
    </Link>
  );
}
