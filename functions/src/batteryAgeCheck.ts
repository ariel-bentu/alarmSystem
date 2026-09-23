// Whether a sensor's battery is overdue for replacement.
//
// Preventive, and deliberately separate from the sensor's own battery_low
// report: that one is reactive and already alerts elsewhere. A "low" on a
// battery changed last month means a faulty cell; a "low" on a two-year-old
// one is simply due. Neither derives from the other.
//
// Pure, like deviceOnline.ts — the Firestore walk and the Telegram send live
// in deadSensorCheck.ts, which already iterates every project's sensors.
//
// The month arithmetic is duplicated from web/src/features/configure/
// batteryAge.ts on purpose: web/ and functions/ are separate packages with no
// shared module, the same reason types.ts exists twice.

import { Timestamp } from "firebase-admin/firestore";
import { Sensor } from "./types";

/** Used when a project has no batteryAlertMonths of its own. Must match the
 *  web default in batteryAge.ts, or the UI would highlight a different set of
 *  sensors than the alert fires for. */
export const DEFAULT_BATTERY_ALERT_MONTHS = 12;

/**
 * When the battery currently in this sensor started its life, in epoch ms.
 *
 * Falls back to pairedAt, which is what gives every sensor an age even
 * before anyone records a replacement. One consequence worth knowing: on the
 * first run after this ships, every sensor paired longer ago than the
 * threshold is immediately overdue and will alert once. That is correct —
 * those batteries really are that old.
 *
 * Null when both dates are missing. pairedAt is written on create so this
 * should not happen, but treating it as epoch 0 would make the sensor look
 * decades old and fire a bogus alert on the next noon run.
 */
export function batteryStartedAtMs(
  sensor: Partial<Pick<Sensor, "batteryChangedAt" | "pairedAt">>
): number | null {
  if (sensor.batteryChangedAt) return sensor.batteryChangedAt.toMillis();
  if (sensor.pairedAt) return sensor.pairedAt.toMillis();
  return null;
}

/** Whole calendar months elapsed, never negative. */
export function batteryAgeMonths(startedAtMs: number, nowMs: number): number {
  if (nowMs <= startedAtMs) return 0;
  const start = new Date(startedAtMs);
  const now = new Date(nowMs);
  let months =
    (now.getFullYear() - start.getFullYear()) * 12 +
    (now.getMonth() - start.getMonth());
  if (now.getDate() < start.getDate()) months -= 1;
  return Math.max(0, months);
}

/**
 * Whether to send a stale-battery alert for this sensor right now.
 *
 * False once alertSentAt is set: the battery stays old until someone replaces
 * it, so without that marker this would Telegram the same sensor every noon.
 * The web UI clears the marker when a new change date is recorded, which is
 * what allows the next battery to alert in its turn.
 */
export function shouldAlertStaleBattery({
  startedAtMs,
  alertSentAt,
  thresholdMonths,
  nowMs,
}: {
  startedAtMs: number | null;
  alertSentAt: Timestamp | null | undefined;
  thresholdMonths: number;
  nowMs: number;
}): boolean {
  if (startedAtMs === null) return false;
  if (thresholdMonths <= 0) return false; // Project-wide off switch
  if (alertSentAt) return false; // Already alerted for this battery
  return batteryAgeMonths(startedAtMs, nowMs) >= thresholdMonths;
}
