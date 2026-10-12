"use client";

import * as TabsPrimitive from "@radix-ui/react-tabs";
import { motion } from "framer-motion";
import { createContext, forwardRef, useContext, useId } from "react";
import { cn } from "./cn";

type TabsStyle = "underline" | "pill";
const TabsCtx = createContext<{ value?: string; id: string; variant: TabsStyle }>({ id: "", variant: "underline" });

/**
 * Radix tabs with an animated indicator that glides between triggers.
 * Controlled (`value` + `onValueChange`) so the indicator knows where to sit.
 */
export function Tabs({
  value,
  onValueChange,
  variant = "underline",
  className,
  children,
  ...props
}: Omit<React.ComponentPropsWithoutRef<typeof TabsPrimitive.Root>, "value" | "onValueChange"> & {
  value: string;
  onValueChange: (value: string) => void;
  variant?: TabsStyle;
}) {
  const id = useId();
  return (
    <TabsCtx.Provider value={{ value, id, variant }}>
      <TabsPrimitive.Root value={value} onValueChange={onValueChange} className={className} {...props}>
        {children}
      </TabsPrimitive.Root>
    </TabsCtx.Provider>
  );
}

export const TabsList = forwardRef<
  React.ElementRef<typeof TabsPrimitive.List>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.List>
>(function TabsList({ className, ...props }, ref) {
  const { variant } = useContext(TabsCtx);
  return (
    <TabsPrimitive.List
      ref={ref}
      className={cn(
        "scrollbar-none relative flex items-center overflow-x-auto",
        variant === "underline" ? "gap-5 border-b border-border" : "gap-1 rounded-lg border border-border bg-muted/60 p-1",
        className,
      )}
      {...props}
    />
  );
});

export const TabsTrigger = forwardRef<
  React.ElementRef<typeof TabsPrimitive.Trigger>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Trigger>
>(function TabsTrigger({ className, children, value, ...props }, ref) {
  const ctx = useContext(TabsCtx);
  const active = ctx.value === value;
  return (
    <TabsPrimitive.Trigger
      ref={ref}
      value={value}
      className={cn(
        "relative inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap text-sm font-medium transition-colors",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
        ctx.variant === "underline" ? "pb-2.5 pt-1" : "z-0 rounded-md px-3 py-1.5",
        active ? "text-foreground" : "text-muted-foreground hover:text-foreground",
        className,
      )}
      {...props}
    >
      {active ? (
        <motion.span
          layoutId={`tab-indicator-${ctx.id}`}
          aria-hidden="true"
          className={cn(
            "absolute",
            ctx.variant === "underline"
              ? "inset-x-0 bottom-0 h-0.5 rounded-full bg-foreground"
              : "inset-0 -z-10 rounded-md border border-border bg-card shadow-xs",
          )}
          transition={{ type: "spring", stiffness: 500, damping: 38 }}
        />
      ) : null}
      {children}
    </TabsPrimitive.Trigger>
  );
});

export const TabsContent = forwardRef<
  React.ElementRef<typeof TabsPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Content>
>(function TabsContent({ className, ...props }, ref) {
  return <TabsPrimitive.Content ref={ref} className={cn("mt-4 animate-fade-in focus-visible:outline-none", className)} {...props} />;
});
