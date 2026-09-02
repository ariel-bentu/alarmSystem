// Deciding whether a recomputed edge timestamp may replace the stored one.
//
// THE BUG THIS EXISTS TO PREVENT (production, 2026-09-02): a 16:45 -> 16:48
// schedule armed at 16:45:34. scheduleTick correctly advanced only the arm,
// leaving nextDisarmAt at TODAY 16:48. But onScheduleChange triggers on any
// document write — including scheduleTick's own lastFiredAt write — and ran
// 0.5s later, recomputed BOTH edges from `now`, and overwrote nextDisarmAt
// with TOMORROW 16:48. (nextDisarmInstant derives the disarm from armAt,
// which by then was tomorrow's arm.) The disarm never came due, nothing was
// logged, and the house stayed armed.
//
// The rule cannot simply be "always keep the earlier future value": editing
// disarmTime from 16:48 to 17:30 must take effect, and that moves the edge
// LATER. So the caller tells us whether the wall-clock definition changed.

export interface PendingInput {
  /** Currently stored edge timestamp, in ms, or null. */
  storedMs: number | null;
  /** Freshly recomputed edge timestamp, in ms, or null. */
  computedMs: number | null;
  /**
   * True when the user actually changed this edge's definition (its HH:MM,
   * the day set, the one-off date, or enabled state). An edit must win even
   * when it moves the edge later; a mere re-trigger must not.
   */
  definitionChanged: boolean;
  nowMs: number;
}

/**
 * Which timestamp to persist: `true` = keep the stored one, `false` = take
 * the recomputed one.
 */
export function keepStoredEdge(input: PendingInput): boolean {
  const { storedMs, computedMs, definitionChanged, nowMs } = input;

  // Nothing stored, or the user redefined this edge — the fresh value wins.
  if (storedMs === null) return false;
  if (definitionChanged) return false;

  // A stored time in the past is spent, not pending. Replacing it is what
  // lets a long-disabled schedule recompute from now on re-enable.
  if (storedMs <= nowMs) return false;

  // Stored edge is still in the future and its definition did not change.
  // Keep it if it is EARLIER than the recomputed one: that is the in-flight
  // cycle's own edge, and the recomputed value belongs to the next cycle.
  if (computedMs === null) return true;
  return storedMs < computedMs;
}
