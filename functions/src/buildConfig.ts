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
import { sensorFamilyId } from "./sensorFamily";

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
    // Same spread-not-undefined reason as `x` above, plus: an unset min gap
    // must leave the payload byte-identical to what it was before the field
    // existed, since the device polls this every 5s.
    const g =
      typeof condition.min_gap_sec === "number" && condition.min_gap_sec > 0
        ? { g: condition.min_gap_sec }
        : {};
    return { t, n: condition.count, w: condition.window_sec, ...g, ...x };
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

// NVR settings bundle, kept as one object so the trailing param stays
// order-independent and self-documenting rather than six more positional
// scalars. Everything optional: a project with NVR off (or not yet
// configured) passes nothing, and no NVR keys are emitted.
export interface NvrSettings {
  nvrMode?: "off" | "capture" | "capture+judge";
  nvrHost?: string;
  nvrPort?: number;
  nvrUser?: string;
  nvrPassword?: string;
  captureCooldownSec?: number;
}

const NVR_MODE_CODE: Record<"off" | "capture" | "capture+judge", 0 | 1 | 2> = {
  off: 0,
  capture: 1,
  "capture+judge": 2,
};

// NVR channel range. Mirrors web/src/features/explore/cameraNames.ts; these
// cannot import each other (separate packages), so the bound is duplicated
// the same way the Kerui event nibbles are, and pinned by tests on both
// sides.
const MIN_CHANNEL = 1;
const MAX_CHANNEL = 8;

/**
 * Packs a sensor's camera channel list into the one-byte mask the device
 * config carries: channel N is bit N-1, so channel 1 is 0x01 and channel 8
 * is 0x80. Out-of-range and non-integer entries are DROPPED rather than
 * coerced — a junk value must not silently select a different camera, and
 * must never shift a bit outside the byte the firmware reads into a uint8_t.
 * Mirrored by toCameraMask() in web and CameraGate::channelsFor() in the
 * firmware.
 */
function cameraMaskOf(cameras: number[] | undefined): number {
  if (!Array.isArray(cameras)) return 0;
  let mask = 0;
  for (const channel of cameras) {
    if (typeof channel !== "number" || !Number.isInteger(channel)) continue;
    if (channel < MIN_CHANNEL || channel > MAX_CHANNEL) continue;
    mask |= 1 << (channel - 1);
  }
  return mask;
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
 * @param nvr - Project-level NVR connection settings. Values come from
 *   Firestore project data at runtime — never hardcode secrets here, this
 *   repo is public. Absent or mode "off"/undefined emits no NVR keys at all.
 */
export function buildRtdbConfig(
  rules: Rule[],
  sensors: Sensor[],
  armed: boolean,
  sirenDurationSec: number,
  sirenEnabled = true,
  alwaysRules: Rule[] = [],
  remotes: Remote[] = [],
  sirenBaseAddress?: string,
  nvr?: NvrSettings,
  // Seconds the device delays the siren for a non-definite sensor. 0/unset =
  // fire immediately, the behaviour before the hold existed.
  sirenHoldSec?: number
): RtdbConfig {
  const sensorMap = new Map<string, Sensor>();
  for (const s of sensors) {
    sensorMap.set(s.id, s);
  }
  // `r` now carries 20-bit FAMILY ids, not full 24-bit rfIds. The device
  // matches a received packet by its top 20 bits, so a sensor that sends
  // several codes (motion 0x0061DA, tamper 0x0061DB) collapses to ONE entry
  // — which is the point, and also shortens the config the device polls
  // every 5s. Wire-compatible: `r` was already string[], only the contents
  // get shorter.
  //
  // A sensor whose family cannot be derived (unparseable rfId, no stored
  // familyId) is dropped exactly as an unresolvable sensorId already was.
  const rfIdOf = (sensorId: string) => {
    const sensor = sensorMap.get(sensorId);
    return sensor ? (sensorFamilyId(sensor) ?? undefined) : undefined;
  };

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
      // Via rfIdOf so pass 1 and pass 2 cannot disagree about a sensor's
      // key: keying r by the raw rfId here while the conditions resolved by
      // family would silently produce an empty condition list.
      const rfId = rfIdOf(sensorId);
      if (!rfId) continue;

      if (!rIndex.has(rfId)) {
        rIndex.set(rfId, r.length);
        r.push(rfId);
      }
    }
  }

  // Per-sensor camera selection as a BITMASK, index-aligned with r. Built by
  // walking r back to the Sensor that produced each family — rIndex alone
  // only maps rfId to index, not back to the originating sensor doc, so this
  // re-derives the family for every sensor and matches it against r's
  // entries. Omitted entirely when every mask is 0, mirroring how m/s are
  // omitted: this config is polled every 5s and most projects have no NVR
  // configured at all.
  //
  // One mask replaces the earlier `os` (out-of-sight) + `cch` (single
  // channel) pair. `Sensor.cameras` is an explicit list, so "no cameras" is
  // just mask 0 and needs no separate opt-out flag — and a sensor can now
  // name SEVERAL channels, which a single `cch` int could not express.
  const familyToSensor = new Map<string, Sensor>();
  for (const sensor of sensors) {
    const family = sensorFamilyId(sensor);
    if (family && !familyToSensor.has(family)) {
      familyToSensor.set(family, sensor);
    }
  }
  const cmask = r.map((rfId) =>
    cameraMaskOf(familyToSensor.get(rfId)?.cameras)
  );
  const hasCameraFlags = cmask.some((v) => v !== 0);

  // Siren hold: which sensors are NOT definite, as indices into r. Sent only
  // when a hold is actually configured — a project that has not opted in gets
  // the identical payload it got before this feature, which matters on a
  // config the device polls every 5s.
  //
  // `!== false` rather than a truthiness test: absent means DEFINITE, the
  // default breachCertainty.isDefiniteBreach owns, so an unconfigured sensor
  // sounds the siren immediately rather than inheriting a hold.
  const hold =
    typeof sirenHoldSec === "number" && sirenHoldSec > 0 ? sirenHoldSec : 0;
  const nonDefinite = r
    .map((rfId, i) =>
      familyToSensor.get(rfId)?.definiteBreach === false ? i : -1
    )
    .filter((i) => i !== -1);
  const holdKeys =
    hold > 0 && nonDefinite.length > 0 ? { sh: hold, nd: nonDefinite } : {};

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
    ...nvrKeys(nvr),
    ...(hasCameraFlags ? { cmask } : {}),
    ...holdKeys,
  };
}

/**
 * The `nh/np/nu/nw/nm/cc` keys, or {} when NVR is off or unconfigured.
 * Shared shape with sirenKey's omit-when-absent contract: RTDB rejects
 * undefined, and an explicit `nm: undefined` would show up in toEqual
 * comparisons.
 */
function nvrKeys(
  nvr?: NvrSettings
): Pick<RtdbConfig, "nh" | "np" | "nu" | "nw" | "nm" | "cc"> {
  const mode = nvr?.nvrMode;
  if (!mode || mode === "off") return {};
  return {
    nm: NVR_MODE_CODE[mode],
    ...(nvr.nvrHost ? { nh: nvr.nvrHost } : {}),
    ...(nvr.nvrPort ? { np: nvr.nvrPort } : {}),
    ...(nvr.nvrUser ? { nu: nvr.nvrUser } : {}),
    ...(nvr.nvrPassword ? { nw: nvr.nvrPassword } : {}),
    ...(nvr.captureCooldownSec !== undefined ? { cc: nvr.captureCooldownSec } : {}),
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
