/**
 * Pure helpers for the live alarm indicator on the Operations page.
 *
 * The device and the server both write /{projectId}/state/alarm_cause, and the
 * SHAPE says which one fired: the device knows only the rfId that tripped
 * (it has no rule or sensor names), while the server writes a ready label.
 * That distinction is what decides which profile grid blinks.
 *
 * The node persists after the alarm ends, so "is there an alarm right now" is
 * the cause's timestamp versus the last acknowledgement rather than the mere
 * presence of a cause. Acknowledging is disarming (or a page-level dismiss);
 * both record the acknowledged `at`.
 */

export type AlarmSide = "device" | "server";

export interface AlarmCause {
  rfId?: string; // device-written: the sensor that fired
  ct?: number; // device-written: condition type index
  label?: string; // server-written: rule name, or sensor name if unnamed
  at?: number; // epoch ms the cause was written
}

/** Narrow an untrusted RTDB value, dropping wrong-typed fields. */
export function parseAlarmCause(value: unknown): AlarmCause | null {
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;
  const cause: AlarmCause = {};
  if (typeof v.rfId === "string") cause.rfId = v.rfId;
  if (typeof v.ct === "number") cause.ct = v.ct;
  if (typeof v.label === "string") cause.label = v.label;
  if (typeof v.at === "number") cause.at = v.at;
  return cause;
}

/** Which side evaluated the alarm, inferred from the cause's shape. */
export function alarmSide(cause: AlarmCause | null): AlarmSide | null {
  if (!cause) return null;
  if (cause.rfId?.trim()) return "device";
  if (cause.label?.trim()) return "server";
  return null;
}

/**
 * True when `cause` describes an alarm the user has not yet acknowledged.
 * `acknowledgedAt` is the `at` of the last dismissed alarm, or null if none.
 */
export function isAlarmActive(
  cause: AlarmCause | null,
  acknowledgedAt: number | null
): boolean {
  if (!cause || typeof cause.at !== "number") return false;
  if (acknowledgedAt === null) return true;
  return cause.at > acknowledgedAt;
}

/**
 * Human-readable cause. A server label is already display-ready; a device
 * rfId is resolved against the paired sensors, falling back to the raw id so
 * an unpaired sensor still names itself.
 */
export function causeLabel(
  cause: AlarmCause | null,
  sensorNamesByRfId: Record<string, string>
): string | null {
  if (!cause) return null;
  const label = cause.label?.trim();
  if (label) return label;
  const rfId = cause.rfId?.trim();
  if (!rfId) return null;
  return sensorNamesByRfId[rfId] ?? rfId;
}
