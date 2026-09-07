// Pure alarm evaluation logic.
// Determines whether an event (given rules and recent event history) should trip an alarm.

import { Rule, Condition, AlarmEvent } from "./types";

export interface EvaluationResult {
  triggered: boolean;
  delayMs?: number; // present if entry_delay — caller should wait before activating siren
  conditionType?: string; // the condition type that tripped
  ruleName?: string; // name of the rule that tripped
}

/**
 * How many of a multi_sensor rule's sensors must be satisfied for it to fire.
 *
 * Absent means ALL of them — the original AND, and what every rule written
 * before the quorum existed means. Shared with buildConfig so the clamp is
 * defined once, and mirrored by multiSensorSatisfied() in the firmware's
 * alarm_state.cpp: if the two ever disagree, the device and the server
 * disagree about whether the house is in alarm.
 *
 * Clamped rather than trusted. A quorum above the sensor count would be
 * permanently unfireable — reachable in practice by unpairing a sensor from a
 * "3 of 3" rule. A value below 1 means "all": it is what the device sends for
 * an unset quorum (Condition::q is a uint8_t where 0 = all), so treating it
 * as 1 would silently turn a multi-sensor rule into an any-one-sensor rule —
 * the opposite of what a multi-sensor rule is for.
 */
export function quorumOf(condition: Condition, sensorCount: number): number {
  const q = condition.quorum;
  if (typeof q !== "number" || !Number.isFinite(q) || q < 1) return sensorCount;
  return Math.min(Math.trunc(q), sensorCount);
}

/**
 * Evaluate whether the given event trips any of the provided rules.
 * @param rules - The rules from the active server profile
 * @param event - The current event being processed
 * @param recentEvents - Past events (same project) sorted newest-first, used for count_in_window and multi_sensor
 * @param now - Current epoch ms (for deterministic testing)
 */
export function evaluateRules(
  rules: Rule[],
  event: AlarmEvent,
  recentEvents: AlarmEvent[],
  now: number
): EvaluationResult {
  for (const rule of rules) {
    // Rule only applies if the event's sensor is listed in rule.sensors
    if (!rule.sensors.includes(event.sensorId)) continue;

    const result = evaluateCondition(rule.condition, rule.sensors, event, recentEvents, now);
    if (result.triggered) {
      return {
        ...result,
        conditionType: rule.condition.type,
        ruleName: rule.name?.trim() || undefined,
      };
    }
  }

  return { triggered: false };
}

function evaluateCondition(
  condition: Condition,
  ruleSensors: string[],
  event: AlarmEvent,
  recentEvents: AlarmEvent[],
  now: number
): EvaluationResult {
  switch (condition.type) {
    case "immediate":
      return { triggered: true };

    case "count_in_window": {
      const count = condition.count ?? 2;
      const windowMs = (condition.window_sec ?? 60) * 1000;
      const cutoff = now - windowMs;

      // Count recent events from the SAME sensor within the window (including the current event)
      const matchingEvents = recentEvents.filter(
        (e) => e.sensorId === event.sensorId && e.timestamp.toMillis() >= cutoff
      );
      // +1 for the current event which may not yet be in recentEvents
      const total = matchingEvents.length + 1;
      return { triggered: total >= count };
    }

    case "entry_delay": {
      const delayMs = (condition.delay_sec ?? 30) * 1000;
      return { triggered: true, delayMs };
    }

    case "multi_sensor": {
      const windowMs = (condition.window_sec ?? 60) * 1000;
      const cutoff = now - windowMs;

      // A sensor is SATISFIED when it reaches its own required trigger count
      // inside the shared window. Counts default to 1 per sensor. The current
      // event counts towards its own sensor's tally.
      const counts = condition.counts ?? {};
      const satisfied = ruleSensors.filter((sensorId) => {
        const required = counts[sensorId] ?? 1;
        const seen = recentEvents.filter(
          (e) => e.sensorId === sensorId && e.timestamp.toMillis() >= cutoff
        ).length;
        const total = sensorId === event.sensorId ? seen + 1 : seen;
        return total >= required;
      }).length;

      // Fires when ENOUGH sensors are satisfied — all of them by default,
      // which is the original AND. Counted per sensor, so repeated triggers
      // on one sensor satisfy that sensor once and never add to the quorum.
      return { triggered: satisfied >= quorumOf(condition, ruleSensors.length) };
    }

    default:
      return { triggered: false };
  }
}
