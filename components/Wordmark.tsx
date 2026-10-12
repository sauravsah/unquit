import Link from "next/link";

/** The lowercase "unquit" wordmark. The green dot is the only brand flourish. */
export function Wordmark({ href = "/", className = "" }: { href?: string; className?: string }) {
  return (
    <Link href={href} className={`inline-flex items-baseline text-xl font-semibold tracking-tight text-ink ${className}`}>
      unquit<span className="text-brand">.</span>
    </Link>
  );
}
