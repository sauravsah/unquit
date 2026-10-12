"use client";

import { useTheme } from "next-themes";
import { Toaster as Sonner, toast } from "sonner";

/** Mounted once in the root providers. Call `toast.success("Saved")` from anywhere. */
export function Toaster() {
  const { resolvedTheme } = useTheme();
  return (
    <Sonner
      theme={resolvedTheme === "dark" ? "dark" : "light"}
      position="bottom-right"
      gap={8}
      closeButton
      toastOptions={{
        classNames: {
          toast:
            "group !rounded-xl !border !border-border !bg-popover !text-popover-foreground !shadow-float !font-sans",
          description: "!text-muted-foreground",
          success: "[&_[data-icon]]:!text-brand",
          error: "[&_[data-icon]]:!text-danger",
          actionButton: "!bg-foreground !text-background !rounded-md",
        },
      }}
    />
  );
}

export { toast };
