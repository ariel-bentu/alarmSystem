// Per-sensor breach certainty: does a trigger from this sensor mean a
// confirmed break-in, or does it need camera confirmation?
//
// Pure and separate from onAlarm.ts so the whole matrix is testable without
// the Functions emulator — the same split as alarmLogic.ts / onAlarm.ts and
// deviceArmNotify.ts / onDeviceArmStateChange.ts.
//
// The tiers map onto pushover.ts's severities:
//   "alarm"  -> priority  2  Critical Alert, repeats until acknowledged
//   "loud"   -> priority  1  Critical Alert, single shot
//   "notice" -> priority -1  silent

import { Sensor } from "./types";
import { AlarmCause } from "./alarmCause";

/** Just the field these helpers read, so callers may pass a partial sensor. */
type Certainty = Pick<Sensor, "definiteBreach">;

/**
 * Is this sensor's trigger a definite breach?
 *
 * ABSENT/NULL MEANS TRUE, and this is the single place that default lives.
 * Two distinct cases both land here and both fail loud:
 *   - a sensor nobody has configured yet
 *   - a cause that resolved to no sensor at all (deleted, never paired)
 */
export function isDefiniteBreach(
  sensor: Certainty | null | undefined
): boolean {
  return sensor?.definiteBreach !== false;
}

/** Tier for the notification sent when the siren fires. */
export function alarmSeverity(definite: boolean): "alarm" | "loud" {
  return definite ? "alarm" : "loud";
}

/**
 * Tier for the notification sent when the judge returns "breach".
 *
 * Non-definite: the alarm went out as priority 1, so THIS is the escalation
 * and the first emergency push for the event.
 *
 * Definite: onAlarm already sent priority 2, which is still repeating. A
 * second emergency would mean two repeating alerts for one event, so the
 * confirmation is downgraded to a single loud push.
 */
export function breachVerdictSeverity(definite: boolean): "alarm" | "loud" {
  return definite ? "loud" : "alarm";
}

/**
 * Which tier an alarm_cause deserves: the certainty of the SENSOR that fired.
 *
 * Deliberately keyed on the cause's rfId, NOT its label — even though
 * resolveCauseLabel prefers the label for display. A label is free text
 * naming a rule; only the rfId identifies a sensor whose certainty can be
 * read. (This is why onSensorEvent writes both.)
 *
 * NO RULE LOOKUP, deliberately — do not reintroduce one. An earlier version
 * derived the tier from the covering rule's members (all must be definite,
 * since a multi_sensor condition is an AND). Two things made that unworkable
 * against real data:
 *
 *  1. Rule membership is NOT exclusive. A sensor commonly belongs to several
 *     rules at once — e.g. a 1-member count_in_window AND a 2-member
 *     multi_sensor. The old code took `rules.find(...)`, the FIRST match, so
 *     Firestore's arbitrary document order decided the notification tier.
 *     Non-deterministic: the same sensor could alert at a different priority
 *     on each trigger.
 *  2. The cause does not record WHICH rule fired. `ct` is a condition TYPE
 *     index, not a rule id, so the firing rule cannot be identified at all
 *     without a firmware change.
 *
 * Using the sensor's own flag is deterministic and is what the UI checkbox
 * actually sets, so what the owner ticks is what they get.
 *
 * Every genuine unknown returns true (definite, fail loud): no cause, a
 * label-only cause (tamper, or any pre-fix server write), or an rfId that
 * matches no sensor.
 */
export function resolveCauseCertainty(
  cause: AlarmCause | null,
  sensorsById: Record<string, Certainty>,
  sensorIdsByRfId: Record<string, string>
): boolean {
  const rfId = cause?.rfId?.trim();
  if (!rfId) return true;

  const sensorId = sensorIdsByRfId[rfId];
  if (!sensorId) return true;

  return isDefiniteBreach(sensorsById[sensorId] ?? null);
}
