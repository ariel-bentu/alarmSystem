/**
 * Pure helper: identify unknown sensor rfIds from RTDB events
 * that are not yet paired in Firestore.
 */

import { familyIdOf, normaliseFamilyId } from "./keruiEvent";

/**
 * Given a list of rfIds observed in RTDB events and the rfIds already paired
 * (from Firestore sensors), returns the observed rfIds that belong to NO
 * paired sensor.
 *
 * Matching is by FAMILY — the top 20 bits — not by the whole 24-bit code.
 * The bottom nibble is an event code, so a paired sensor emits several codes
 * and every code but the paired one used to show up here as a separate
 * "unrecognised sensor". That is what made 0x0061DB (a tamper) appear in the
 * pairing list alongside its own paired 0x0061DA.
 *
 * `knownRfIds` may hold either full 6-digit rfIds or stored 5-digit
 * familyIds. They are told apart by LENGTH, not by guessing: shifting an
 * already-shifted family again would turn "0x0061D" into "0x00061" and match
 * nothing.
 *
 * A code whose family cannot be derived (a non-hex RTDB key like "SIREN0" or
 * "REMOTE") is compared verbatim instead — it is not a sensor, and silently
 * swallowing it would hide it from whoever is looking at the list.
 */
export function getUnknownRfIds(
  eventRfIds: string[],
  knownRfIds: string[]
): string[] {
  const knownFamilies = new Set(
    knownRfIds.map((id) => normaliseFamilyId(id) ?? familyIdOf(id) ?? id)
  );
  const seen = new Set<string>();
  const result: string[] = [];

  for (const rfId of eventRfIds) {
    const key = familyIdOf(rfId) ?? rfId;
    if (!knownFamilies.has(key) && !seen.has(key)) {
      seen.add(key);
      // The full observed CODE is returned, not the family: the event code
      // is the information the pairing UI shows, and pairing stores the code
      // it was given alongside the family it derives.
      result.push(rfId);
    }
  }

  return result;
}
