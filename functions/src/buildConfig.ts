// Pure builder: converts Firestore profile+rules+sensors into the RtdbConfig
// object that gets written to RTDB /{projectId}/config for the device.

import {
  Rule,
  Sensor,
  Condition,
  RtdbCondition,
  RtdbConfig,
} from "./types";

const CONDITION_TYPE_CODE: Record<Condition["type"], 0 | 1 | 2 | 3> = {
  immediate: 0,
  count_in_window: 1,
  entry_delay: 2,
  multi_sensor: 3,
};

/**
 * Translate a Firestore condition into the device-facing short-key form.
 * multi_sensor `counts` — keyed by Firestore sensorId in Firestore, by rfId
 * in the old RTDB shape — are now keyed by **index into `r`**, resolved via
 * `indexOfRfId`. Sensors that cannot be resolved are dropped, and every
 * remaining participant is given an explicit count (defaulting to 1) so the
 * device never has to infer participants.
 */
function toRtdbCondition(
  condition: Condition,
  ruleSensorIds: string[],
  rfIdOf: (sensorId: string) => string | undefined,
  indexOfRfId: (rfId: string) => number
): RtdbCondition {
  const t = CONDITION_TYPE_CODE[condition.type];

  if (condition.type === "count_in_window") {
    return { t, n: condition.count, w: condition.window_sec };
  }
  if (condition.type === "entry_delay") {
    return { t, y: condition.delay_sec };
  }
  if (condition.type === "multi_sensor") {
    const k: Record<string, number> = {};
    for (const sensorId of ruleSensorIds) {
      const rfId = rfIdOf(sensorId);
      if (!rfId) continue;
      const idx = indexOfRfId(rfId);
      if (idx === -1) continue;
      k[String(idx)] = condition.counts?.[sensorId] ?? 1;
    }
    return { t, w: condition.window_sec, k };
  }
  // immediate
  return { t };
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
  const rfIdOf = (sensorId: string) => sensorMap.get(sensorId)?.rfId;

  // Pass 1: determine r (stable order = first-seen order across rules).
  const r: string[] = [];
  const rIndex = new Map<string, number>(); // rfId -> index into r

  for (const rule of rules) {
    for (const sensorId of rule.sensors) {
      const sensor = sensorMap.get(sensorId);
      if (!sensor) continue;
      const rfId = sensor.rfId;

      if (!rIndex.has(rfId)) {
        rIndex.set(rfId, r.length);
        r.push(rfId);
      }
    }
  }

  const indexOfRfId = (rfId: string) => rIndex.get(rfId) ?? -1;
  const conditionsByRfId = new Map<string, RtdbCondition[]>();
  for (const rfId of r) {
    conditionsByRfId.set(rfId, []);
  }

  // Pass 2: translate each rule's condition once, append to every
  // participating sensor's condition list.
  for (const rule of rules) {
    const translated = toRtdbCondition(rule.condition, rule.sensors, rfIdOf, indexOfRfId);
    for (const sensorId of rule.sensors) {
      const rfId = rfIdOf(sensorId);
      if (!rfId) continue;
      conditionsByRfId.get(rfId)!.push(translated);
    }
  }

  const c: RtdbCondition[][] = r.map((rfId) => conditionsByRfId.get(rfId)!);

  return { a: armed, d: sirenDurationSec, r, c };
}
