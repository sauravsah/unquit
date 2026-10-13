"use client";

import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { Loader2 } from "lucide-react";
import { forwardRef } from "react";
import { cn } from "./cn";

export const buttonVariants = cva(
  [
    "relative inline-flex select-none items-center justify-center gap-2 whitespace-nowrap rounded-lg font-medium",
    "transition-[background-color,border-color,color,box-shadow,transform] duration-150 ease-spring",
    "active:scale-[0.97] disabled:pointer-events-none disabled:opacity-50 aria-busy:cursor-progress",
    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
    "[&_svg]:pointer-events-none [&_svg]:shrink-0",
  ],
  {
    variants: {
      variant: {
        /** Near-black (white in dark mode). The default action. */
        primary: "bg-foreground text-background shadow-xs shadow-inner-hi hover:bg-foreground/85",
        /**
         * Bright green, near-black text, soft glow. One per screen: the action that
         * makes money. Dark text on bright green reads on light and dark pages alike.
         */
        brand:
          "bg-gradient-to-b from-brand-glow to-brand font-semibold text-zinc-950 shadow-glow-sm hover:shadow-glow hover:brightness-110",
        /** White pill with dark text, for CTAs that sit on an always-dark surface (the CTA band). */
        inverse:
          "bg-zinc-50 font-semibold text-zinc-950 shadow-[0_0_0_1px_rgba(255,255,255,.2),0_10px_40px_-8px_rgba(34,197,94,.6)] hover:bg-zinc-200",
        secondary: "border border-border bg-card text-foreground shadow-xs hover:border-input hover:bg-muted/60",
        ghost: "text-muted-foreground hover:bg-muted hover:text-foreground",
        outline: "border border-border bg-transparent text-foreground hover:bg-muted/60",
        danger: "bg-danger text-white shadow-xs hover:bg-danger/90",
        link: "h-auto px-0 text-brand-text underline-offset-4 hover:underline active:scale-100",
      },
      size: {
        sm: "h-8 px-3 text-xs",
        md: "h-9 px-4 text-sm",
        lg: "h-11 px-5 text-base",
        xl: "h-12 px-6 text-base",
        icon: "h-9 w-9",
        "icon-sm": "h-8 w-8",
      },
    },
    defaultVariants: { variant: "primary", size: "md" },
  },
);

export type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> &
  VariantProps<typeof buttonVariants> & {
    /** Render the child element (e.g. a Link) with button styles. */
    asChild?: boolean;
    /** Shows a spinner, keeps the width, and blocks clicks. */
    loading?: boolean;
  };

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className, variant, size, asChild = false, loading = false, disabled, children, ...props },
  ref,
) {
  if (asChild) {
    return <Slot ref={ref} className={cn(buttonVariants({ variant, size }), className)} {...props}>{children}</Slot>;
  }
  return (
    <button
      ref={ref}
      className={cn(buttonVariants({ variant, size }), className)}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...props}
    >
      {loading ? (
        <>
          <span className="absolute inset-0 flex items-center justify-center">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          </span>
          <span className="invisible inline-flex items-center gap-2">{children}</span>
        </>
      ) : (
        children
      )}
    </button>
  );
});
