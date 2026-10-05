// A brief, self-dismissing confirmation.
//
// Extracted from OperationsPage's Manual Capture button, which owned the only
// copy. The Configure tabs need the same thing for a different reason: a
// checkbox or <select> there saves on change rather than via a Save button, so
// without a toast there is nothing at all to show the write happened.
//
// The 3s timeout here must stay in step with the toast-out animation delay in
// styles/components.css (0.3s ease 2.7s). The element animates itself out and
// this removes it; if they diverge it either vanishes mid-fade or lingers
// invisibly over the page.
import { useCallback, useEffect, useRef, useState } from "react";

export const TOAST_MS = 3000;

export function useToast() {
  const [toast, setToast] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Cleared on unmount: a tab switch unmounts the panel while a toast is still
  // pending, and the stale timer would setState on a dead component.
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    []
  );

  const showToast = useCallback((msg: string) => {
    // Re-showing restarts the clock rather than queueing: two quick saves
    // should read as one confirmation, not stack up.
    if (timer.current) clearTimeout(timer.current);
    setToast(msg);
    timer.current = setTimeout(() => setToast(null), TOAST_MS);
  }, []);

  return { toast, showToast };
}
