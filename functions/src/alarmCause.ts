/**
 * Pure helpers for the alarm "cause" written to /{projectId}/state/alarm_cause
 * just before state/siren_active flips true.
 *
 * Two writers, deliberately different shapes:
 *  - the server (onSensorEvent) knows the rule, so it writes a ready `label`
 *  - the device knows only the rfId that fired (it has no rule or sensor
 *    *names*), so it writes `rfId` and leaves the naming to onAlarm
 *
 * onAlarm is the single alarm notifier and normalises both into one message.
 */

import { Rule } from "./types";

/**
 * How long a written cause stays valid. A cause older than this is assumed to
 * be left over from a previous alarm and is ignored, so a stale node can never
 * mislabel an unrelated later alarm.
 */
export const CAUSE_MAX_AGE_MS = 60_000;

export interface AlarmCause {
  label?: string; // server-written: the rule name, or the sensor name if unnamed
  rfId?: string; // device-written: the sensor that fired
  ct?: number; // device-written: condition type index (reserved; not used in the label)
  at?: number; // epoch ms the cause was written
}

/**
 * Narrow an untrusted RTDB value into an AlarmCause, dropping fields of the
 * wrong type instead of throwing. Returns null if the value is not an object.
 */
export function parseCause(value: unknown): AlarmCause | null {
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;
  const cause: AlarmCause = {};
  if (typeof v.label === "string") cause.label = v.label;
  if (typeof v.rfId === "string") cause.rfId = v.rfId;
  if (typeof v.ct === "number") cause.ct = v.ct;
  if (typeof v.at === "number") cause.at = v.at;
  return cause;
}

/**
 * True when `cause` was written recently enough to describe the alarm now
 * firing. A cause timestamped slightly ahead of `now` is accepted — device and
 * server clocks drift, and skew should not silently drop the label.
 */
export function isCauseFresh(cause: AlarmCause | null, now: number): boolean {
  if (!cause || typeof cause.at !== "number") return false;
  return now - cause.at <= CAUSE_MAX_AGE_MS;
}

/**
 * The human-readable cause for the Telegram message.
 *
 * A server-written label wins outright. Otherwise the device's rfId is mapped
 * to the name of the first rule covering that sensor, falling back to the
 * sensor's own name, then to the raw rfId. Returns null when the cause
 * identifies nothing — the caller then sends its generic message.
 */
export function resolveCauseLabel(
  cause: AlarmCause,
  rules: Rule[],
  sensorNamesByRfId: Record<string, string>,
  sensorIdsByRfId: Record<string, string>
): string | null {
  const label = cause.label?.trim();
  if (label) return label;

  const rfId = cause.rfId?.trim();
  if (!rfId) return null;

  const sensorId = sensorIdsByRfId[rfId];
  if (sensorId) {
    const rule = rules.find((r) => r.sensors.includes(sensorId));
    const ruleName = rule?.name?.trim();
    if (ruleName) return ruleName;
  }

  return sensorNamesByRfId[rfId] ?? rfId;
}
