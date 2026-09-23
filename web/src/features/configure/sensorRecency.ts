/**
 * Pure helpers for "when was this sensor last heard from" across both the
 * paired (Firestore) and unrecognised (RTDB) sensor tables.
 *
 * RTDB events arrive live; Firestore's `lastSeen` is written by the mirroring
 * function and lags slightly, but survives RTDB event cleanup. Taking the max
 * of the two keeps the display live without losing history.
 */

import { familyIdOf, eventOfRfId, type KeruiEvent } from "./keruiEvent";

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

/**
 * Most recent sighting of a sensor across EVERY code in its family, plus the
 * most recent event type seen.
 *
 * A sensor emits several 24-bit codes — motion 0x0061DA, tamper 0x0061DB —
 * and RTDB keys events by the full code. An exact-key lookup therefore
 * reports "last seen" from only the one code the sensor happened to be
 * paired on, so a PIR that had been tampered five minutes ago could still
 * read as silent for days.
 *
 * `lastEvent` is null when nothing in the family has been seen in RTDB.
 */
export function familyLastSeen(
  familyId: string | null,
  eventTiming: Record<string, EventTiming>,
  firestoreLastSeenMs: number | null
): { lastSeen: number | null; lastEvent: KeruiEvent | null } {
  let best: number | null = null;
  let bestCode: string | null = null;

  if (familyId !== null) {
    for (const [code, timing] of Object.entries(eventTiming)) {
      if (familyIdOf(code) !== familyId) continue;
      if (best === null || timing.lastSeen > best) {
        best = timing.lastSeen;
        bestCode = code;
      }
    }
  }

  const lastEvent = bestCode === null ? null : eventOfRfId(bestCode);
  if (best === null) return { lastSeen: firestoreLastSeenMs, lastEvent };
  if (firestoreLastSeenMs === null) return { lastSeen: best, lastEvent };
  return { lastSeen: Math.max(best, firestoreLastSeenMs), lastEvent };
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
