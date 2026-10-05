// Inline help marker: a "?" button that toggles a visible instruction panel
// on click. Native title tooltips are unreliable (and unreachable on touch),
// so we render our own.
//
// Extracted from SettingsPage when its fields were split across the General,
// Notifications and Siren tabs — three consumers rather than one.
import { useState } from "react";

export function Help({ text, label }: { text: string; label: string }) {
  const [open, setOpen] = useState(false);
  return (
    <span className="help">
      <button
        type="button"
        className="help__btn"
        aria-label={label}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        ?
      </button>
      {open && (
        <span role="tooltip" className="help__panel">
          {text}
        </span>
      )}
    </span>
  );
}
