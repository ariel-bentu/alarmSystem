// A horizontally scrolling tab strip that never hides items off-screen
// without saying so.
//
// The old header was one non-wrapping flex row, so on a phone the later nav
// items were simply clipped and unreachable. Scrolling alone would fix
// reachability but not discoverability, so this also:
//   - paints a fade at whichever edge has more content (data-overflow-*)
//   - scrolls the active tab into view on mount and whenever it changes
//
// Works in both writing directions: in RTL, scrollLeft is negative (or
// reversed, depending on the engine), so overflow is measured with absolute
// values rather than assuming a left-to-right origin.
import { ReactNode, useCallback, useEffect, useRef } from "react";

interface Props {
  children: ReactNode;
  /** Changes to this re-run the "scroll the selected tab into view" effect. */
  activeKey?: string;
  ariaLabel?: string;
}

export function ScrollingTabs({ children, activeKey, ariaLabel }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const updateOverflow = useCallback(() => {
    const el = scrollRef.current;
    const wrap = wrapRef.current;
    if (!el || !wrap) return;

    // Normalise across engines: |scrollLeft| is the distance from the start
    // edge in both LTR and RTL.
    const start = Math.abs(el.scrollLeft);
    const max = el.scrollWidth - el.clientWidth;
    // 1px slack: fractional layout widths otherwise leave a permanent fade.
    wrap.dataset.overflowStart = String(start > 1);
    wrap.dataset.overflowEnd = String(start < max - 1);
  }, []);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;

    updateOverflow();
    el.addEventListener("scroll", updateOverflow, { passive: true });

    // Overflow depends on the container width, which changes on rotate and
    // on desktop window resize.
    const ro = new ResizeObserver(updateOverflow);
    ro.observe(el);

    return () => {
      el.removeEventListener("scroll", updateOverflow);
      ro.disconnect();
    };
  }, [updateOverflow]);

  // Bring the selected tab into view, so arriving on a route whose tab is
  // scrolled off doesn't look like the tab is missing.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const selected = el.querySelector<HTMLElement>(
      '[aria-selected="true"], [aria-current="page"]'
    );
    selected?.scrollIntoView({ inline: "nearest", block: "nearest" });
    updateOverflow();
  }, [activeKey, updateOverflow]);

  return (
    <div className="tabs-wrap" ref={wrapRef}>
      <div className="tabs" ref={scrollRef} role="tablist" aria-label={ariaLabel}>
        {children}
      </div>
    </div>
  );
}
