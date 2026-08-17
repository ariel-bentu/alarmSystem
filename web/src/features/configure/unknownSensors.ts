/**
 * Pure helper: identify unknown sensor rfIds from RTDB events
 * that are not yet paired in Firestore.
 */

/**
 * Given a list of rfIds observed in RTDB events and the set of
 * rfIds already paired (from Firestore sensors), returns the
 * rfIds that are unknown (not yet paired).
 */
export function getUnknownRfIds(
  eventRfIds: string[],
  knownRfIds: string[]
): string[] {
  const knownSet = new Set(knownRfIds);
  const seen = new Set<string>();
  const result: string[] = [];

  for (const rfId of eventRfIds) {
    if (!knownSet.has(rfId) && !seen.has(rfId)) {
      seen.add(rfId);
      result.push(rfId);
    }
  }

  return result;
}
