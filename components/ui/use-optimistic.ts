"use client";

import { useCallback, useRef, useState } from "react";
import { toast } from "./toast";

/**
 * Optimistic value: the UI flips immediately, `save` runs in the background,
 * and the value rolls back (with an error toast) if it throws.
 */
export function useOptimisticValue<T>(
  initial: T,
  save: (next: T) => Promise<void>,
  messages: { success?: (next: T) => string; error?: string } = {},
): [T, (next: T) => Promise<boolean>, boolean] {
  const [value, setValue] = useState(initial);
  const [pending, setPending] = useState(false);
  const committed = useRef(initial);
  const saveRef = useRef(save);
  saveRef.current = save;

  const set = useCallback(
    async (next: T) => {
      setValue(next);
      setPending(true);
      try {
        await saveRef.current(next);
        committed.current = next;
        if (messages.success) toast.success(messages.success(next));
        return true;
      } catch (err) {
        setValue(committed.current);
        toast.error(err instanceof Error && err.message ? err.message : messages.error ?? "Couldn't save. Please try again.");
        return false;
      } finally {
        setPending(false);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  return [value, set, pending];
}
