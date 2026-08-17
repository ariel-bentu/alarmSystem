// Pure builder: converts Firestore profile+rules+sensors into the RtdbConfig object
// that gets written to RTDB /{projectId}/config for the device.

import {
  Rule,
  Sensor,
  Condition,
  RtdbCondition,
  RtdbConfig,
  RtdbConfigSensor,
} from "./types";

/**
 * Translate a Firestore condition into the device-facing form. The device only
 * knows rfIds, so multi_sensor `counts` — keyed by Firestore sensorId — must be
 * re-keyed by rfId. Sensors that cannot be resolved are dropped, and every
 * sensor of the rule is given an explicit count (defaulting to 1) so the device
 * does not have to infer the participants.
 */
function toRtdbCondition(
  condition: Condition,
  ruleSensorIds: string[],
  rfIdOf: (sensorId: string) => string | undefined
): RtdbCondition {
  if (condition.type !== "multi_sensor") return condition;

  const counts: Record<string, number> = {};
  for (const sensorId of ruleSensorIds) {
    const rfId = rfIdOf(sensorId);
    if (!rfId) continue;
    counts[rfId] = condition.counts?.[sensorId] ?? 1;
  }

  return { ...condition, counts };
}

/**
 * Build the RTDB config object from the active-on-device profile's data.
 * @param rules - All rules belonging to the active profile
 * @param sensors - All sensors in the project (need rfId lookup)
 * @param armed - Current armed state
 * @param sirenDurationSec - Project-level siren duration
 */
export function buildRtdbConfig(
  rules: Rule[],
  sensors: Sensor[],
  armed: boolean,
  sirenDurationSec: number
): RtdbConfig {
  const sensorMap = new Map<string, Sensor>();
  for (const s of sensors) {
    sensorMap.set(s.id, s);
  }

  const configSensors: Record<string, RtdbConfigSensor> = {};

  const rfIdOf = (sensorId: string) => sensorMap.get(sensorId)?.rfId;

  for (const rule of rules) {
    // Translate once per rule so every participating sensor gets the same
    // rfId-keyed condition object.
    const condition = toRtdbCondition(rule.condition, rule.sensors, rfIdOf);

    for (const sensorId of rule.sensors) {
      const sensor = sensorMap.get(sensorId);
      if (!sensor) continue;

      const rfId = sensor.rfId;

      if (configSensors[rfId]) {
        // Sensor already present from another rule — add the condition
        configSensors[rfId].conditions.push(condition);
      } else {
        configSensors[rfId] = {
          name: sensor.name,
          enabled: true,
          conditions: [condition],
        };
      }
    }
  }

  return {
    armed,
    siren_duration_sec: sirenDurationSec,
    sensors: configSensors,
  };
}
