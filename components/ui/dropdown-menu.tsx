"use client";

import * as DM from "@radix-ui/react-dropdown-menu";
import { Check } from "lucide-react";
import { forwardRef } from "react";
import { cn } from "./cn";

export const DropdownMenu = DM.Root;
export const DropdownMenuTrigger = DM.Trigger;
export const DropdownMenuGroup = DM.Group;
export const DropdownMenuRadioGroup = DM.RadioGroup;

const itemClass = cn(
  "relative flex cursor-pointer select-none items-center gap-2 rounded-lg px-2 py-1.5 text-sm text-foreground outline-none transition-colors",
  "data-[highlighted]:bg-muted data-[disabled]:pointer-events-none data-[disabled]:opacity-50 [&_svg]:h-4 [&_svg]:w-4 [&_svg]:text-muted-foreground",
);

export const DropdownMenuContent = forwardRef<
  React.ElementRef<typeof DM.Content>,
  React.ComponentPropsWithoutRef<typeof DM.Content>
>(function DropdownMenuContent({ className, sideOffset = 6, ...props }, ref) {
  return (
    <DM.Portal>
      <DM.Content
        ref={ref}
        sideOffset={sideOffset}
        className={cn(
          "z-50 min-w-[10rem] overflow-hidden rounded-xl border border-border bg-popover p-1 text-popover-foreground shadow-float",
          "data-[state=open]:animate-slide-up",
          className,
        )}
        {...props}
      />
    </DM.Portal>
  );
});

export const DropdownMenuItem = forwardRef<
  React.ElementRef<typeof DM.Item>,
  React.ComponentPropsWithoutRef<typeof DM.Item> & { destructive?: boolean }
>(function DropdownMenuItem({ className, destructive, ...props }, ref) {
  return <DM.Item ref={ref} className={cn(itemClass, destructive && "text-danger [&_svg]:text-danger", className)} {...props} />;
});

export const DropdownMenuRadioItem = forwardRef<
  React.ElementRef<typeof DM.RadioItem>,
  React.ComponentPropsWithoutRef<typeof DM.RadioItem>
>(function DropdownMenuRadioItem({ className, children, ...props }, ref) {
  return (
    <DM.RadioItem ref={ref} className={cn(itemClass, "pr-8", className)} {...props}>
      {children}
      <DM.ItemIndicator className="absolute right-2 flex">
        <Check className="!text-brand-text" />
      </DM.ItemIndicator>
    </DM.RadioItem>
  );
});

export function DropdownMenuLabel({ className, ...props }: React.ComponentPropsWithoutRef<typeof DM.Label>) {
  return <DM.Label className={cn("px-2 py-1.5 text-2xs font-medium uppercase tracking-wider text-muted-foreground", className)} {...props} />;
}

export function DropdownMenuSeparator({ className, ...props }: React.ComponentPropsWithoutRef<typeof DM.Separator>) {
  return <DM.Separator className={cn("-mx-1 my-1 h-px bg-border", className)} {...props} />;
}
