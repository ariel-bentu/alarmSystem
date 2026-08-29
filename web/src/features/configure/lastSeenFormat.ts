/** Human-friendly "last seen" rendering for the sensor tables.
 *
 *  A raw locale timestamp ("27/08/2026, 14:23:05") is precise and hard to
 *  read at a glance. What matters when checking a sensor is usually "how long
 *  ago" for recent activity, and "which day" for anything older. */

import type { TranslationKey } from "@/i18n/en";

/** Anything at or beyond this is shown as a clock time, not "N hours ago". */
const RELATIVE_LIMIT_MS = 24 * 60 * 60 * 1000;
const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

/** Matches useT()'s t. Typed against the real key union so a renamed or
 *  deleted time string is a compile error here, not a "time.minutesAgo"
 *  leaking into the table. */
type Translate = (
  key: TranslationKey,
  vars?: Record<string, string | number>
) => string;

// 24-hour explicitly, not the locale default: the browser's locale is often
// en-US even for a Hebrew speaker, which renders "05:29 PM" where this table
// wants "17:29". Times here are scanned and compared, so a fixed, compact
// form beats a locale-idiomatic one.
const CLOCK: Intl.DateTimeFormatOptions = {
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
};

/** Clock time only, e.g. "10:23". Used where the date is already established
 *  by a day heading above the row. */
export function timeOfDay(ts: number): string {
  return new Date(ts).toLocaleTimeString(undefined, CLOCK);
}

/** Date and time, for anything too old for relative phrasing. */
export function dateAndTime(ts: number): string {
  return new Date(ts).toLocaleString(undefined, {
    day: "2-digit",
    month: "2-digit",
    ...CLOCK,
  });
}

/**
 * "just now" / "a minute ago" / "5 minutes ago" / "3 hours ago", falling back
 * to a date-and-time string beyond 24h.
 *
 * A timestamp slightly in the future (device and browser clocks disagree)
 * reads as "just now" rather than a negative count.
 */
export function formatRelative(ts: number, now: number, t: Translate): string {
  const delta = now - ts;
  if (delta < MINUTE_MS) return t("time.justNow");

  if (delta < HOUR_MS) {
    const mins = Math.floor(delta / MINUTE_MS);
    return mins === 1 ? t("time.minuteAgo") : t("time.minutesAgo", { count: mins });
  }

  if (delta < RELATIVE_LIMIT_MS) {
    const hours = Math.floor(delta / HOUR_MS);
    return hours === 1 ? t("time.hourAgo") : t("time.hoursAgo", { count: hours });
  }

  return dateAndTime(ts);
}

/** Weekday and date for a group heading, e.g. "Wednesday 27/8". */
export function dayHeading(ts: number): string {
  const d = new Date(ts);
  const weekday = d.toLocaleDateString(undefined, { weekday: "long" });
  const day = d.toLocaleDateString(undefined, { day: "numeric", month: "numeric" });
  return `${weekday} ${day}`;
}
