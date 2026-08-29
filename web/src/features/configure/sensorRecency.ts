/**
 * Pure helpers for "when was this sensor last heard from" across both the
 * paired (Firestore) and unrecognised (RTDB) sensor tables.
 *
 * RTDB events arrive live; Firestore's `lastSeen` is written by the mirroring
 * function and lags slightly, but survives RTDB event cleanup. Taking the max
 * of the two keeps the display live without losing history.
 */

/** A sensor seen this recently is highlighted as "just now". */
export const JUST_SEEN_MS = 60_000;

/** Timing summary for an rfId seen in RTDB events. */
export interface EventTiming {
  firstSeen: number; // epoch ms
  lastSeen: number; // epoch ms
  count: number;
}

/**
 * Most recent sighting of `rfId` from either source, or null if neither has
 * ever seen it.
 */
export function effectiveLastSeen(
  rfId: string,
  eventTiming: Record<string, EventTiming>,
  firestoreLastSeenMs: number | null
): number | null {
  const rtdb = eventTiming[rfId]?.lastSeen ?? null;
  if (rtdb === null) return firestoreLastSeenMs;
  if (firestoreLastSeenMs === null) return rtdb;
  return Math.max(rtdb, firestoreLastSeenMs);
}

/** True when `lastSeen` falls inside the "just now" window ending at `now`. */
export function isJustSeen(lastSeen: number | null, now: number): boolean {
  if (lastSeen === null) return false;
  return now - lastSeen <= JUST_SEEN_MS;
}

/**
 * Copy of `items` ordered most-recently-seen first. Items never seen sink to
 * the bottom, keeping their original relative order.
 */
export function sortByLastSeenDesc<T>(
  items: readonly T[],
  getLastSeen: (item: T) => number | null
): T[] {
  return [...items].sort((a, b) => {
    const la = getLastSeen(a);
    const lb = getLastSeen(b);
    if (la === null && lb === null) return 0;
    if (la === null) return 1;
    if (lb === null) return -1;
    return lb - la;
  });
}
