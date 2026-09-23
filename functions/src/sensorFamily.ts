// Resolving an observed RF code to a paired sensor.
//
// Matching moved from the full 24-bit rfId to the 20-bit FAMILY, because the
// bottom nibble is an event code: one physical sensor emits 0x0061DA when it
// sees motion and 0x0061DB when tampered, and exact-rfId matching made the
// tamper look like a separate, unpaired sensor — invisible to every rule and
// every alert.

import { familyIdOf, formatFamilyId } from "./keruiEvent";
import { Sensor } from "./types";

/**
 * A sensor's matching key. Prefers the stored `familyId`, falling back to one
 * derived from `rfId`.
 *
 * The fallback is what makes this deployable BEFORE the migration runs: a
 * sensor doc written last year has no familyId, and deriving it here means
 * such a doc still matches every code its sensor sends. It also means a
 * failed or half-finished migration degrades to "works", not "stops matching".
 */
export function sensorFamilyId(sensor: Pick<Sensor, "rfId" | "familyId">): string | null {
  const stored = sensor.familyId?.trim();
  if (stored) {
    // Re-parsed and re-formatted rather than upper-cased: a bare
    // `.toUpperCase()` also capitalises the "0x" prefix, giving "0X0061D",
    // which then never equals a derived "0x0061D" and silently stops the
    // sensor matching anything. Round-tripping through formatFamilyId makes
    // every path produce one canonical form.
    const parsed = parseInt(stored, 16);
    if (Number.isFinite(parsed)) return formatFamilyId(parsed);
  }
  return familyIdOf(sensor.rfId);
}

/**
 * Find the sensor a received code belongs to, by family.
 *
 * Returns null when nothing matches — an UNPAIRED code, which callers must
 * leave in RTDB rather than drop: the pairing UI discovers new sensors by
 * reading those keys.
 *
 * On a collision (two sensors claiming one family) the FIRST is returned.
 * The migration refuses to create that state, so it can only arise from a
 * hand-edited doc; picking the first is deterministic given a stable sensor
 * order and is preferable to matching neither.
 */
export function findSensorByFamily<T extends Pick<Sensor, "rfId" | "familyId">>(
  sensors: T[],
  rfId: string
): T | null {
  const family = familyIdOf(rfId);
  if (family === null) return null;
  for (const sensor of sensors) {
    if (sensorFamilyId(sensor) === family) return sensor;
  }
  return null;
}
