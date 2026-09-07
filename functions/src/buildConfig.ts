// Pure builder: converts Firestore profile+rules+sensors into the RtdbConfig
// object that gets written to RTDB /{projectId}/config for the device.

import {
  Rule,
  Sensor,
  Remote,
  Condition,
  RtdbCondition,
  RtdbConfig,
} from "./types";
import { quorumOf } from "./alarmLogic";

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
  indexOfRfId: (rfId: string) => number,
  always = false
): RtdbCondition {
  const t = CONDITION_TYPE_CODE[condition.type];
  // Spread rather than assigning undefined: an explicit `x: undefined` shows
  // up in toEqual comparisons, and RTDB rejects undefined values outright.
  const x = always ? ({ x: 1 } as const) : {};

  if (condition.type === "count_in_window") {
    return { t, n: condition.count, w: condition.window_sec, ...x };
  }
  if (condition.type === "entry_delay") {
    return { t, y: condition.delay_sec, ...x };
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
    // Clamped against the participants that SURVIVED resolution, not
    // ruleSensorIds: an unresolvable sensor is dropped from k above, and a
    // quorum higher than what remains would be permanently unfireable.
    const participants = Object.keys(k).length;
    const quorum = quorumOf(condition, participants);
    // Omitted when it equals the participant count — that is the plain AND,
    // and keeping the payload identical matters on a config polled every 5s.
    const q = quorum < participants ? { q: quorum } : {};
    return { t, w: condition.window_sec, k, ...q, ...x };
  }
  // immediate
  return { t, ...x };
}

/**
 * Build the RTDB config object from the active-on-device profile's data.
 * @param rules - All rules belonging to the active profile
 * @param sensors - All sensors in the project (need rfId lookup)
 * @param armed - Current armed state
 * @param sirenDurationSec - Project-level siren duration
 * @param sirenEnabled - Whether the device should sound the siren
 * @param remotes - Paired remote controls, pushed so the device can act on
 *   them with no cloud connection
 * @param sirenBaseAddress - The device's own siren identity ("0x..."), echoed
 *   back so a device whose EEPROM was wiped can re-adopt it rather than
 *   generating a new address the physical siren is not paired to
 */
export function buildRtdbConfig(
  rules: Rule[],
  sensors: Sensor[],
  armed: boolean,
  sirenDurationSec: number,
  sirenEnabled = true,
  alwaysRules: Rule[] = [],
  remotes: Remote[] = [],
  sirenBaseAddress?: string
): RtdbConfig {
  const sensorMap = new Map<string, Sensor>();
  for (const s of sensors) {
    sensorMap.set(s.id, s);
  }
  const rfIdOf = (sensorId: string) => sensorMap.get(sensorId)?.rfId;

  // Always-rules come from EVERY profile, not just the active one: a smoke
  // rule sitting in an inactive profile must still reach the device, or the
  // UI would show it enabled while nothing happens on hardware.
  // De-duplicated by id, because a rule in the active profile arrives twice.
  const seenRuleIds = new Set(rules.map((r) => r.id));
  const allRules = [...rules];
  for (const r of alwaysRules) {
    if (!seenRuleIds.has(r.id)) {
      seenRuleIds.add(r.id);
      allRules.push(r);
    }
  }

  // Pass 1: determine r (stable order = first-seen order across rules).
  const r: string[] = [];
  const rIndex = new Map<string, number>(); // rfId -> index into r

  for (const rule of allRules) {
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
  for (const rule of allRules) {
    const translated = toRtdbCondition(
      rule.condition,
      rule.sensors,
      rfIdOf,
      indexOfRfId,
      rule.always === true
    );
    for (const sensorId of rule.sensors) {
      const rfId = rfIdOf(sensorId);
      if (!rfId) continue;
      conditionsByRfId.get(rfId)!.push(translated);
    }
  }

  const c: RtdbCondition[][] = r.map((rfId) => conditionsByRfId.get(rfId)!);

  // Remote identities as numbers. Unparseable entries are dropped rather
  // than sent as NaN, which RTDB would reject outright.
  const m = remotes
    .map((remote) => parseInt(remote.identity, 16))
    .filter((id) => Number.isFinite(id));

  // Spread rather than assigning undefined: RTDB rejects undefined values,
  // and an explicit `m: undefined` shows up in toEqual comparisons — the
  // same reason toRtdbCondition spreads `x` above.
  return {
    a: armed,
    d: sirenDurationSec,
    e: sirenEnabled,
    r,
    c,
    ...(m.length > 0 ? { m } : {}),
    ...sirenKey(sirenBaseAddress),
  };
}

/**
 * The `s` (siren base address) key, or {} when there is nothing usable to
 * send. Shared with onProfileChange's thin-config path so both config shapes
 * carry the siren address identically — a project with no active profile must
 * still be able to drive its siren, exactly as with `m`.
 *
 * Firestore holds the "0x..." string; the device-facing config carries a
 * number. Unparseable values are dropped rather than sent as NaN, which RTDB
 * would reject outright.
 */
export function sirenKey(
  sirenBaseAddress?: string
): { s: number } | Record<string, never> {
  if (!sirenBaseAddress) return {};
  const s = parseInt(sirenBaseAddress, 16);
  return Number.isFinite(s) && s > 0 ? { s } : {};
}
