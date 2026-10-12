"use client";

import * as SliderPrimitive from "@radix-ui/react-slider";
import { forwardRef } from "react";
import { cn } from "./cn";

export const Slider = forwardRef<
  React.ElementRef<typeof SliderPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof SliderPrimitive.Root> & { thumbLabel?: string }
>(function Slider({ className, thumbLabel, ...props }, ref) {
  return (
    <SliderPrimitive.Root
      ref={ref}
      className={cn("relative flex h-5 w-full touch-none select-none items-center", className)}
      {...props}
    >
      <SliderPrimitive.Track className="relative h-1.5 w-full grow overflow-hidden rounded-full bg-muted">
        <SliderPrimitive.Range className="absolute h-full rounded-full bg-gradient-to-r from-brand to-brand-glow" />
      </SliderPrimitive.Track>
      <SliderPrimitive.Thumb
        aria-label={thumbLabel}
        className={cn(
          "block h-5 w-5 cursor-grab rounded-full border-2 border-brand bg-white shadow-glow-sm transition-transform duration-150",
          "hover:scale-110 active:scale-95 active:cursor-grabbing",
          "focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-brand/25",
        )}
      />
    </SliderPrimitive.Root>
  );
});
