/** Battery replacement dates and ages for the sensor table.
 *
 *  A Kerui sensor's battery dies silently, and the device's own battery_low
 *  report is reactive — by the time it arrives the sensor is nearly useless.
 *  Recording when a battery was last changed makes the question "which of
 *  these is overdue?" answerable BEFORE one fails.
 *
 *  Independent of Sensor.batteryStatus, which is the sensor's own claim.
 *  Both are shown: a "low" on a battery changed last month means a faulty
 *  cell, while a "low" on a two-year-old one is simply due. Recording a
 *  replacement date deliberately does NOT reset batteryStatus — only the
 *  sensor can say it is no longer low.
 *
 *  Pure, like lastSeenFormat.ts and sensorRecency.ts beside it, so the date
 *  handling is testable without mounting SensorsTab. */

import type { Timestamp } from "firebase/firestore";
import type { TranslationKey } from "@/i18n/en";
import type { Sensor } from "@/types";

/** Used when a project has no batteryAlertMonths of its own. */
export const DEFAULT_BATTERY_ALERT_MONTHS = 12;

/** Matches useT()'s t, typed against the real key union so a renamed string
 *  is a compile error here rather than a raw key leaking into the table. */
type Translate = (
  key: TranslationKey,
  vars?: Record<string, string | number>
) => string;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * When the battery currently in this sensor started its life, in epoch ms.
 *
 * Falls back to pairedAt because a battery was presumably fresh when the
 * sensor was paired. That fallback is what gives EVERY sensor an age from day
 * one: the alternative — only ageing sensors with an explicit record — would
 * silently never alert on the sensors nobody got round to recording, which
 * are exactly the ones most likely to hold a dying battery.
 *
 * Null only when both dates are missing, which should not happen since
 * pairedAt is written on create. Treating that as epoch 0 would make the
 * sensor look decades old and fire a bogus alert, so it is excluded instead.
 */
export function batteryStartedAt(
  sensor: Partial<Pick<Sensor, "batteryChangedAt" | "pairedAt">>
): number | null {
  if (sensor.batteryChangedAt) return sensor.batteryChangedAt.toMillis();
  const paired = sensor.pairedAt as Timestamp | null | undefined;
  if (paired) return paired.toMillis();
  return null;
}

/** Whole months elapsed, never negative — a future start date is a typo, not
 *  a negative age. Calendar months rather than 30-day blocks, so "changed on
 *  the 15th" stays the 15th regardless of month length. */
export function batteryAgeMonths(startedAtMs: number, nowMs: number): number {
  if (nowMs <= startedAtMs) return 0;
  const start = new Date(startedAtMs);
  const now = new Date(nowMs);
  let months =
    (now.getFullYear() - start.getFullYear()) * 12 +
    (now.getMonth() - start.getMonth());
  // Not a full month until the day-of-month is reached.
  if (now.getDate() < start.getDate()) months -= 1;
  return Math.max(0, months);
}

/** Whether this battery is at or past the project's threshold. A threshold of
 *  zero or less is the project-wide off switch. */
export function isBatteryStale(
  startedAtMs: number | null,
  nowMs: number,
  thresholdMonths: number
): boolean {
  if (startedAtMs === null) return false;
  if (thresholdMonths <= 0) return false;
  return batteryAgeMonths(startedAtMs, nowMs) >= thresholdMonths;
}

/** "today" / "3 days ago" / "11 months ago". Null when unknown, so the caller
 *  can render "not recorded" rather than inventing an age. */
export function formatBatteryAge(
  startedAtMs: number | null,
  nowMs: number,
  t: Translate
): string | null {
  if (startedAtMs === null) return null;
  const months = batteryAgeMonths(startedAtMs, nowMs);
  if (months >= 1) {
    return t("cfg.sensors.batteryMonthsAgo", { count: months });
  }
  const days = Math.floor(Math.max(0, nowMs - startedAtMs) / DAY_MS);
  if (days < 1) return t("cfg.sensors.batteryToday");
  return t("cfg.sensors.batteryDaysAgo", { count: days });
}

/** Epoch ms -> "yyyy-mm-dd" in LOCAL time, for <input type="date">.
 *
 *  Deliberately not toISOString().slice(0, 10): that is UTC, so an evening in
 *  Asia/Jerusalem renders as tomorrow's date. */
export function toDateInputValue(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** "yyyy-mm-dd" -> epoch ms at LOCAL midnight, or null if unusable.
 *
 *  Built with the Date(y, m, d) constructor rather than parsed: Date.parse of
 *  a bare "2026-09-23" is UTC midnight, which is the PREVIOUS day in any
 *  UTC+ zone and would shift every date the user picked.
 *
 *  Future dates are rejected. The input carries max={today}, but a typed or
 *  pasted value bypasses that in some browsers, and a battery replaced
 *  tomorrow is a typo rather than a fact worth storing. */
export function fromDateInputValue(
  value: string,
  nowMs: number
): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;

  const d = new Date(year, month - 1, day);
  // Rejects real-looking but nonexistent dates: new Date(2026, 1, 30) rolls
  // over to March 2nd, so the parts coming back out prove the date existed.
  if (
    d.getFullYear() !== year ||
    d.getMonth() !== month - 1 ||
    d.getDate() !== day
  ) {
    return null;
  }

  // Compared by calendar day, not by instant: "today" must be accepted even
  // though local midnight is in the past relative to now.
  const today = new Date(nowMs);
  const todayMidnight = new Date(
    today.getFullYear(),
    today.getMonth(),
    today.getDate()
  ).getTime();
  if (d.getTime() > todayMidnight) return null;

  return d.getTime();
}
