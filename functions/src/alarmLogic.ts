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

      // Every sensor of the rule must reach its required trigger count inside
      // the shared window (AND). Counts default to 1 per sensor. The current
      // event counts towards its own sensor's tally.
      const counts = condition.counts ?? {};
      return {
        triggered: ruleSensors.every((sensorId) => {
          const required = counts[sensorId] ?? 1;
          const seen = recentEvents.filter(
            (e) => e.sensorId === sensorId && e.timestamp.toMillis() >= cutoff
          ).length;
          const total = sensorId === event.sensorId ? seen + 1 : seen;
          return total >= required;
        }),
      };
    }

    default:
      return { triggered: false };
  }
}
