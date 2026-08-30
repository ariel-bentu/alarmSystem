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
