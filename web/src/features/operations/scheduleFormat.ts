// Pure label helpers for the schedule rows. Kept out of the component so the
// string shapes are testable without rendering.

/** "HH:MM" -> minutes since local midnight. */
export function minutesOf(time: string): number {
  const [h, m] = time.split(":").map(Number);
  return h * 60 + m;
}

/**
 * The row's headline. A disarm-only window shows a single time behind an
 * arrow, which makes its shape obvious at a glance.
 *
 * RENDER THIS LTR. Every part of the result — both times and the arrow — is
 * bidi-neutral, so inside Hebrew the bidi algorithm reorders the runs and
 * "16:48 → 16:45" paints as "16:45 ← 16:48": the window reads backwards and
 * the arrow appears to point the wrong way. The arrow encodes arm -> disarm
 * order, not reading order, so it must not mirror with the page.
 * SchedulesPanel applies the shared `.ltr` utility for this. A unit test
 * cannot catch it — the string is correct; only its painted order is not.
 */
export function formatTimeRange(
  armTime: string | null,
  disarmTime: string
): string {
  return armTime ? `${armTime} → ${disarmTime}` : `→ ${disarmTime}`;
}

/** "every day" / "Mon, Wed, Fri" / "2026-09-01". */
export function formatRecurrence(
  days: number[],
  date: string | null,
  dayNames: string[],
  everyDayLabel: string
): string {
  if (date) return date;
  if (days.length === 0) return "";
  if (days.length === 7) return everyDayLabel;
  return [...days]
    .sort((a, b) => a - b)
    .map((d) => dayNames[d])
    .join(", ");
}
