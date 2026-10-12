import { forwardRef } from "react";
import { cn } from "./cn";

export const fieldClass = cn(
  "flex w-full rounded-lg border border-input bg-card px-3 text-[16px] text-foreground shadow-xs sm:text-sm", // 16px on phones stops iOS zooming into fields
  "placeholder:text-subtle transition-[border-color,box-shadow] duration-150",
  "hover:border-muted-foreground/40",
  "focus-visible:border-brand focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-brand/15 focus-visible:ring-offset-0",
  "disabled:cursor-not-allowed disabled:opacity-50",
  "aria-[invalid=true]:border-danger aria-[invalid=true]:ring-danger/15",
);

export const Input = forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(function Input(
  { className, type = "text", ...props },
  ref,
) {
  return <input ref={ref} type={type} className={cn(fieldClass, "h-9 py-2", type === "number" && "tabular-nums", className)} {...props} />;
});

export const Textarea = forwardRef<HTMLTextAreaElement, React.TextareaHTMLAttributes<HTMLTextAreaElement>>(function Textarea(
  { className, ...props },
  ref,
) {
  return <textarea ref={ref} className={cn(fieldClass, "min-h-[96px] py-2 leading-relaxed", className)} {...props} />;
});

/** A plain <select> styled like the other fields. Use it inside forms that need native behaviour. */
export const NativeSelect = forwardRef<HTMLSelectElement, React.SelectHTMLAttributes<HTMLSelectElement>>(function NativeSelect(
  { className, children, ...props },
  ref,
) {
  return (
    <span className={cn("relative inline-flex", className?.includes("w-full") && "w-full")}>
      <select
        ref={ref}
        className={cn(
          fieldClass,
          "h-9 cursor-pointer appearance-none py-2 pr-8",
          className,
        )}
        {...props}
      >
        {children}
      </select>
      <svg aria-hidden="true" viewBox="0 0 16 16" className="pointer-events-none absolute right-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground">
        <path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </span>
  );
});

export function Label({ className, ...props }: React.LabelHTMLAttributes<HTMLLabelElement>) {
  return <label className={cn("text-sm font-medium text-foreground", className)} {...props} />;
}

/** Label + control + hint/error, stacked. */
export function Field({
  label,
  hint,
  error,
  className,
  children,
}: {
  label: React.ReactNode;
  hint?: React.ReactNode;
  error?: React.ReactNode;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <label className={cn("block space-y-1.5", className)}>
      <span className="block text-sm font-medium text-foreground">{label}</span>
      {children}
      {error ? (
        <span role="alert" className="block text-xs text-danger">
          {error}
        </span>
      ) : hint ? (
        <span className="block text-xs text-muted-foreground">{hint}</span>
      ) : null}
    </label>
  );
}

export function Kbd({ className, ...props }: React.HTMLAttributes<HTMLElement>) {
  return (
    <kbd
      className={cn(
        "inline-flex h-5 min-w-[20px] items-center justify-center rounded border border-border bg-muted px-1 font-mono text-[10px] font-medium text-muted-foreground shadow-[inset_0_-1px_0_rgb(var(--border))]",
        className,
      )}
      {...props}
    />
  );
}
