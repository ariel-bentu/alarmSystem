// A "pending alarm": an alarm whose notification is waiting for the AI
// judge's verdict instead of going out immediately.
//
// Written by onAlarm when shouldDeferToJudge() says so, cleared by whoever
// announces the alarm first:
//   - onSnapshotUploaded, on a breach (P2 escalation) or safe (silent
//     all-clear) verdict;
//   - doSchedule's sweeper, if no verdict arrives before the deadline.
//
// IDENTITY IS THE 20-BIT FAMILY, not the full rfId and not a {rfId, ts} pair.
// The two writers cannot agree on anything narrower: onAlarm reads
// /state/alarm_cause, which carries a 20-bit family when the DEVICE wrote it
// and a full 24-bit rfId when the SERVER did, while onSnapshotUploaded has the
// snapshot object's full rfId and its own capture `ts`. The cause's `at` and
// the snapshot's `ts` are different clocks on different events, so keying on
// either would strand markers that no verdict could ever clear. The family is
// exactly the join onSnapshotUploaded's armed gate already performs.
//
// One pending alarm per sensor at a time is therefore the model. That is
// sound: CAUSE_MAX_AGE_MS is 60s and the capture cooldown gates repeat
// triggers, so two independent *deferred* alarms for one sensor inside that
// window are not reachable in practice — and if one did overwrite the other,
// both describe the same sensor and the surviving marker still gets announced.

import { causeFamilyOf } from "./keruiEvent";

/**
 * How long a deferred alarm waits before the sweeper announces it anyway.
 *
 * The fail-loud backstop: if the NVR is down, the judge errors, or the
 * snapshot upload never lands, the alarm is still announced — just late.
 * Chosen under 60s so doSchedule's per-minute tick catches it on the first
 * pass after the deadline rather than the second.
 */
export const PENDING_FALLBACK_SEC = 45;

export interface PendingAlarm {
  /** Epoch ms the alarm was deferred. */
  at?: number;
  /** The cause's family, for diagnostics (the doc id carries it too). */
  rfId?: string;
  /** Pre-resolved so the sweeper need not redo onAlarm's lookups. */
  label?: string | null;
  /** The sensor's certainty at defer time, for the fallback's tier. */
  definite?: boolean;
}

/**
 * Document id for a pending alarm: the cause's 20-bit family, canonicalised.
 *
 * Accepts either identity the cause may carry (family or full rfId) and
 * returns null when it carries neither — the caller must then not defer,
 * because nothing would be able to clear the marker.
 */
export function pendingAlarmId(causeRfId: string | undefined | null): string | null {
  const raw = causeRfId?.trim();
  if (!raw) return null;
  return causeFamilyOf(raw);
}

/** True when a deferred alarm has waited past the fallback deadline. */
export function isPendingAlarmStale(marker: PendingAlarm, now: number): boolean {
  // No timestamp => cannot be aged => announce it rather than strand it.
  if (typeof marker.at !== "number" || !Number.isFinite(marker.at)) return true;
  return now - marker.at > PENDING_FALLBACK_SEC * 1000;
}
