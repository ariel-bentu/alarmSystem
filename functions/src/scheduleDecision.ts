// Pure decision for a single schedule edge. Kept separate from scheduleTick
// so the rules are testable without emulating Firestore.

export type EdgeKind = "arm" | "disarm";
export type EdgeDecision =
  | "fire"
  | "skip_stale"
  | "skip_disabled_profile"
  | "not_due";

/**
 * How late an edge may be and still fire. Downtime from a deploy or outage
 * must not arm the house at 08:00 because a 23:00 edge was still pending —
 * the same reasoning as onAlarm's 60s cutoff on alarm_cause: a stale trigger
 * is worse than a missed one.
 */
export const STALE_CUTOFF_MS = 15 * 60 * 1000;

export function decideEdge(
  dueAt: Date,
  now: Date,
  profileEnabled: boolean,
  edge: EdgeKind
): EdgeDecision {
  const lateBy = now.getTime() - dueAt.getTime();
  if (lateBy < 0) return "not_due";
  if (lateBy > STALE_CUTOFF_MS) return "skip_stale";
  // Arming a profile Operations hides would be invisible and unpredictable.
  // Disarming is always safe, so it fires regardless.
  if (edge === "arm" && !profileEnabled) return "skip_disabled_profile";
  return "fire";
}
