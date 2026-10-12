"use client";

import { useEffect, useRef } from "react";

export const SHORTCUTS: { keys: string[]; label: string }[] = [
  { keys: ["⌘", "K"], label: "Open the command palette" },
  { keys: ["?"], label: "Show keyboard shortcuts" },
  { keys: ["["], label: "Collapse or expand the sidebar" },
  { keys: ["G", "O"], label: "Go to Overview" },
  { keys: ["G", "S"], label: "Go to Saves & ledger" },
  { keys: ["G", "F"], label: "Go to Cancel flows" },
  { keys: ["G", "P"], label: "Go to Failed payments" },
  { keys: ["G", "B"], label: "Go to Billing" },
  { keys: ["G", "T"], label: "Go to Test widget" },
  { keys: ["G", ","], label: "Go to Settings" },
  { keys: ["⇧", "D"], label: "Toggle light / dark" },
  { keys: ["⌘", "S"], label: "Save (cancel flow and failed-payment editors)" },
];

export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target.isContentEditable || !!target.closest("[role=dialog] [cmdk-input]");
}

/**
 * Global keyboard shortcuts. "g" starts a two-key sequence that expires after
 * a second. Ignored while typing in a field.
 */
export function useShortcuts(handlers: {
  palette: () => void;
  help: () => void;
  sidebar: () => void;
  theme: () => void;
  go: (key: string) => boolean;
}) {
  const ref = useRef(handlers);
  ref.current = handlers;

  useEffect(() => {
    let pendingG = 0;
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        ref.current.palette();
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented || isTypingTarget(e.target)) return;
      const now = Date.now();
      if (pendingG && now - pendingG < 1000) {
        pendingG = 0;
        if (ref.current.go(e.key.toLowerCase())) e.preventDefault();
        return;
      }
      if (e.key === "g") {
        pendingG = now;
        return;
      }
      if (e.key === "?") {
        e.preventDefault();
        ref.current.help();
      } else if (e.key === "[") {
        ref.current.sidebar();
      } else if (e.key === "D" && e.shiftKey) {
        ref.current.theme();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}
