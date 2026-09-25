/**
 * Pure guard for the pairing dialog.
 *
 * Two clicks on Save 1.5s apart created two identical sensor docs for family
 * 0x309A0 on 2026-09-25 — `addDoc` always mints a new id, so nothing upstream
 * deduplicates, and each click also wrote a rule into every profile. The
 * in-flight half of that is state the component owns; the half that can be
 * tested in isolation is "is this family already paired?", which is also the
 * better error: a second physical press of the same sensor a minute later
 * would otherwise pair it twice just as easily as a double click.
 */

import { familyIdOf, normaliseFamilyId } from "./keruiEvent";

/** The family a sensor is matched on: the stored field, else derived. */
export function sensorFamily(sensor: {
  familyId?: string | null;
  rfId: string;
}): string | null {
  const stored = sensor.familyId ? normaliseFamilyId(sensor.familyId) : null;
  return stored ?? familyIdOf(sensor.rfId);
}

/**
 * True when `rfId` belongs to a family that is already paired.
 *
 * Compared by FAMILY, not by the 24-bit code: pairing a sensor's tamper code
 * when its motion code is already paired is the same physical device, and
 * that is the whole point of the 20-bit identity.
 *
 * An rfId whose family cannot be derived (a hand-typed non-hex string) is
 * compared verbatim — it is still worth catching an exact repeat.
 */
export function isAlreadyPaired(
  rfId: string,
  sensors: readonly { familyId?: string | null; rfId: string }[]
): boolean {
  const key = familyIdOf(rfId) ?? rfId.trim();
  return sensors.some((s) => (sensorFamily(s) ?? s.rfId.trim()) === key);
}
