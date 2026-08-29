// Warns before losing unsaved edits, covering both ways out of a page:
// closing/reloading the tab, and navigating within the app.
//
// react-router's useBlocker needs a data router (createBrowserRouter); this
// app uses the declarative <BrowserRouter>, so in-app navigation is guarded
// by intercepting clicks on links in the capture phase instead. That is
// enough here because every in-app navigation goes through an <a> rendered
// by NavLink/Link.
import { useEffect } from "react";

export function useUnsavedChangesWarning(
  dirty: boolean,
  confirmMessage: string
): void {
  // Tab close / reload / external navigation. The browser shows its own
  // generic wording; returnValue just opts in to the prompt.
  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [dirty]);

  // In-app navigation. Capture phase so this runs before react-router's own
  // click handler, which is what lets preventDefault actually stop the
  // navigation rather than merely undoing it afterwards.
  useEffect(() => {
    if (!dirty) return;

    const onClick = (e: MouseEvent) => {
      // Let modified clicks (new tab/window) and non-primary buttons through:
      // they do not destroy this page's state.
      if (e.defaultPrevented || e.button !== 0) return;
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;

      const anchor = (e.target as HTMLElement | null)?.closest("a");
      if (!anchor) return;

      const href = anchor.getAttribute("href");
      // Ignore anchors that do not navigate away in-app.
      if (!href || href.startsWith("#") || anchor.target === "_blank") return;
      if (href === window.location.pathname) return;

      if (!window.confirm(confirmMessage)) {
        e.preventDefault();
        e.stopPropagation();
      }
    };

    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  }, [dirty, confirmMessage]);
}
