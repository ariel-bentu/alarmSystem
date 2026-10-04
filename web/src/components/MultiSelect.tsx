// Dropdown multi-select: a trigger button showing the current selection,
// which opens a panel of checkboxes.
//
// Why not a native <select multiple>: it requires Cmd/Ctrl-click to pick a
// second option, and a PLAIN click on another option silently clears every
// other selection. For the per-sensor camera picker — where "this sensor
// watches the front door AND the driveway" is the normal case — that is a trap.
// It also renders as a fixed-height list box rather than a collapsed control,
// so it does not actually save the vertical space a table row wants.
//
// Generic over the value type only insofar as it needs ordering, so values are
// numbers: the one consumer (camera channels) is numeric, and `sorted`
// ascending is part of the contract. Widen it when a second consumer needs to.
import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";

export interface MultiSelectOption {
  value: number;
  label: string;
}

interface MultiSelectProps {
  options: MultiSelectOption[];
  /** Currently selected values. Order is irrelevant; output is always sorted. */
  selected: number[];
  /** Called with the new selection, ascending. Receives [] when emptied. */
  onChange: (next: number[]) => void;
  /** Accessible name for the trigger, e.g. "Cameras". */
  label: string;
  /** Trigger text when nothing is selected, e.g. "No cameras". */
  emptyLabel: string;
}

export function MultiSelect({
  options,
  selected,
  onChange,
  label,
  emptyLabel,
}: MultiSelectProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const id = useId();

  // Viewport coordinates for the portalled panel, measured from the trigger.
  const [pos, setPos] = useState<{ top: number; left: number; width: number }>({
    top: 0,
    left: 0,
    width: 0,
  });

  // Position the panel under the trigger, in viewport coordinates.
  //
  // The panel is PORTALLED to document.body rather than rendered in place,
  // because this control lives inside .table-wrap, whose `overflow-x: auto`
  // establishes a scroll container — and a scroll container clips absolutely
  // positioned descendants on BOTH axes, not just the one named. In-flow, the
  // dropdown was cut off at the table's bottom edge. A portal escapes that; the
  // cost is positioning by hand here.
  useEffect(() => {
    if (!open) return;
    const place = () => {
      const r = triggerRef.current?.getBoundingClientRect();
      if (r) setPos({ top: r.bottom + 4, left: r.left, width: r.width });
    };
    place();
    // `true` captures scrolls on ancestor scrollers (.table-wrap included), not
    // just the window, so the panel tracks the trigger instead of detaching.
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => {
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
    };
  }, [open]);

  // Close on an outside click or Escape. The panel is NOT a descendant of
  // rootRef any more (it is portalled), so an outside test against rootRef
  // alone would treat every click inside the panel as "outside" and close it on
  // the first checkbox — hence the explicit panelRef check too.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (rootRef.current?.contains(target)) return;
      if (panelRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const selectedSet = new Set(selected);
  const summary =
    options
      .filter((o) => selectedSet.has(o.value))
      .map((o) => o.label)
      .join(", ") || emptyLabel;

  /** Toggling never replaces the selection — the point of this component. */
  const toggle = (value: number) => {
    const next = selectedSet.has(value)
      ? selected.filter((v) => v !== value)
      : [...selected, value];
    onChange([...new Set(next)].sort((a, b) => a - b));
  };

  return (
    <div ref={rootRef} style={{ position: "relative" }}>
      <span id={`${id}-label`} className="sr-only">
        {label}
      </span>
      <button
        ref={triggerRef}
        type="button"
        className="input"
        // aria-label would REPLACE the visible summary as the accessible name,
        // leaving a screen reader to announce "Cameras" with no hint of what is
        // selected. aria-labelledby points at both the hidden field label and
        // the visible summary, so the name is "Cameras: Front door, Back yard".
        aria-labelledby={`${id}-label ${id}-summary`}
        aria-haspopup="true"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        style={{ textAlign: "start", cursor: "pointer", width: "100%" }}
      >
        <span id={`${id}-summary`}>{summary}</span> ▾
      </button>

      {open &&
        createPortal(
          <div
            ref={panelRef}
            className="card"
            style={{
              position: "fixed",
              top: pos.top,
              left: pos.left,
              zIndex: 60,
              padding: "var(--sp-2)",
              maxHeight: "14rem",
              overflowY: "auto",
              minWidth: pos.width,
              width: "max-content",
            }}
          >
            {options.map((o) => (
              <label key={o.value} className="check" style={{ display: "flex" }}>
                <input
                  type="checkbox"
                  checked={selectedSet.has(o.value)}
                  onChange={() => toggle(o.value)}
                />
                <span>{o.label}</span>
              </label>
            ))}
          </div>,
          document.body
        )}
    </div>
  );
}
