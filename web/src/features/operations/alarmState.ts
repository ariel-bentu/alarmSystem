import { familyIdOf, normaliseFamilyId } from "../configure/keruiEvent";

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
  rfId?: string;   // device-written: the sensor that fired
  ct?: number;     // device-written: condition type index
  label?: string;  // device or server written: display label
  side?: string;   // device-written for label causes (e.g. SOS): "device"
  at?: number;     // epoch ms the cause was written
}

/** Narrow an untrusted RTDB value, dropping wrong-typed fields. */
export function parseAlarmCause(value: unknown): AlarmCause | null {
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;
  const cause: AlarmCause = {};
  if (typeof v.rfId === "string") cause.rfId = v.rfId;
  if (typeof v.ct === "number") cause.ct = v.ct;
  if (typeof v.label === "string") cause.label = v.label;
  if (typeof v.side === "string") cause.side = v.side;
  if (typeof v.at === "number") cause.at = v.at;
  return cause;
}

/** Which side evaluated the alarm, inferred from the cause's shape. */
export function alarmSide(cause: AlarmCause | null): AlarmSide | null {
  if (!cause) return null;
  if (cause.rfId?.trim()) return "device";
  // Device-written label causes (e.g. SOS) carry side="device" explicitly;
  // absent that field, a label-only cause is server-originated.
  if (cause.label?.trim()) return cause.side === "device" ? "device" : "server";
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
 *
 * The device writes the 20-bit FAMILY, not the 24-bit rfId — alarm rules
 * match on the family, so that is what it knows fired. The sensor map is
 * keyed by full rfId, so an exact lookup misses and the banner degrades to a
 * bare "0x4D6A7". Both forms are therefore tried: exact first (a server or
 * older device write may still carry a full code), then by family.
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
  const exact = sensorNamesByRfId[rfId];
  if (exact) return exact;

  // Canonicalise both sides to a family before comparing. `normaliseFamilyId`
  // is tried first because the cause is USUALLY already a family, and running
  // familyIdOf on one would shift it a second time and match nothing.
  const causeFamily = normaliseFamilyId(rfId) ?? familyIdOf(rfId);
  if (!causeFamily) return rfId;
  for (const [id, name] of Object.entries(sensorNamesByRfId)) {
    const family = normaliseFamilyId(id) ?? familyIdOf(id);
    if (family === causeFamily) return name;
  }
  return rfId;
}
