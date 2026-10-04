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

/**
 * Certainty for a whole rule, from its member sensors.
 *
 * EVERY member must be definite. All, not any: a multi_sensor condition is an
 * AND — it fires only when every member tripped — so the WEAKEST member
 * governs what the combination proves. A door sensor plus a motion sensor
 * firing together is still gated on the motion sensor being right.
 *
 * This is derived rather than defaulted on purpose. A multi-sensor rule
 * exists precisely BECAUSE its members are individually inconclusive: a
 * sensor that were a definite breach on its own would already fire via its
 * own `immediate` rule. Defaulting such a rule to definite (an earlier draft
 * of the design did) gets it exactly backwards.
 *
 * An EMPTY list means no member resolved, which is an unknown — so definite.
 */
export function isRuleDefinite(members: (Certainty | null)[]): boolean {
  if (members.length === 0) return true;
  return members.every((s) => isDefiniteBreach(s));
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
