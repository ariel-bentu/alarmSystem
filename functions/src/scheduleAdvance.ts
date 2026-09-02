// Pure decision for which schedule edge timestamps to rewrite after one edge
// has been handled. Extracted from scheduleTick's advance() so the rule can
// be tested without Firestore.
//
// THE BUG THIS EXISTS TO PREVENT: advance() used to recompute and write BOTH
// nextArmAt and nextDisarmAt after handling EITHER edge. With a schedule of
// arm 16:23 / disarm 16:26, the 16:23 arm fired and immediately rewrote
// nextDisarmAt to the following day — because nextDisarmInstant() anchors to
// `armAt`, which by then was tomorrow's arm. The 16:26 disarm never became
// due, the query never matched it, no warning was logged anywhere, and the
// house stayed armed for 24 hours.
//
// Observed in production 2026-09-02.

// Reuse scheduleDecision's definition rather than declaring a second one —
// two structurally identical types compile fine today and drift apart later.
import { EdgeKind } from "./scheduleDecision";

export interface AdvanceInput {
  /** Which edge was just handled. */
  edge: EdgeKind;
  /** Freshly computed next arm instant, or null if none remains. */
  nextArmAt: Date | null;
  /** Freshly computed next disarm instant, or null if none remains. */
  nextDisarmAt: Date | null;
  /** The OTHER edge's currently stored timestamp (ms), if any. */
  storedOtherEdgeMs: number | null;
  nowMs: number;
}

export interface AdvancePlan {
  /** True when nextArmAt should be written. */
  writeArm: boolean;
  /** True when nextDisarmAt should be written. */
  writeDisarm: boolean;
  /** True when the schedule has nothing left and should disable itself. */
  disable: boolean;
}

/**
 * Only the handled edge is advanced; the other keeps whatever it holds.
 *
 * That asymmetry is the whole point. A schedule that has armed is mid-cycle,
 * and its pending disarm belongs to that cycle — recomputing it from `now`
 * moves it to the next cycle and silently drops the one that is owed.
 */
export function planAdvance(input: AdvanceInput): AdvancePlan {
  const { edge, nextArmAt, nextDisarmAt, storedOtherEdgeMs, nowMs } = input;

  const otherStillPending =
    storedOtherEdgeMs !== null && storedOtherEdgeMs > nowMs;

  return {
    writeArm: edge === "arm",
    writeDisarm: edge === "disarm",
    // Only retire a schedule when nothing remains on EITHER edge — including
    // the pending one we are deliberately not touching. Disabling while a
    // disarm is still owed would strand the system armed, which is the same
    // failure in a different disguise.
    disable: !nextArmAt && !nextDisarmAt && !otherStillPending,
  };
}
