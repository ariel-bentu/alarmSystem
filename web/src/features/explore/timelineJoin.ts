// Joining timeline (snapshot) docs to event rows.
//
// A timeline doc id is `{rfId}_{ts}` and an event row carries its own rfId and
// timestamp, so the two are matched on that pair. Docs with no matching event
// are surfaced as standalone rows, which is how a genuine manual capture
// (rfId "MANUAL", no event row at all) becomes visible.
//
// WHY THE SKEW TOLERANCE: the device used to read time(nullptr) TWICE per
// trigger — once for the snapshot upload path and again inside reportEvent —
// so a trigger that straddled a second boundary wrote an /events key 1000ms
// away from its snapshot's. The exact-match join then declared the timeline doc
// an orphan and the UI labelled a real sensor trigger "manual capture". Seen
// live 2026-10-05: timeline 19:24:44 against event 19:24:45.
//
// The firmware now passes ONE timestamp through both paths, so new rows cannot
// skew. Existing rows already carry it, and no migration can recover the
// intended pairing, so the join tolerates it here instead.

/** Just the fields the join reads. */
export interface JoinEvent {
  rfId: string;
  ms: number;
}

export interface JoinTimeline {
  /** Doc id, `{rfId}_{ts}`. */
  id: string;
  ms: number;
}

/**
 * How far apart a timeline doc and its event row may be and still be the same
 * trigger.
 *
 * 1000ms exactly: the only mechanism that produced a mismatch was two
 * whole-second clock reads, so the error is always 0 or ±1000ms. A wider
 * window would start absorbing genuinely separate triggers of the same sensor
 * — and with captureCooldownSec as low as 10s, those exist.
 */
export const JOIN_SKEW_MS = 1000;

/** The rfId half of a timeline doc id, or the whole id if it has no ts part. */
function rfIdOf(timelineId: string): string {
  const cut = timelineId.lastIndexOf("_");
  return cut > 0 ? timelineId.slice(0, cut) : timelineId;
}

/**
 * Timeline docs with no matching event row.
 *
 * Matched on rfId AND a timestamp within JOIN_SKEW_MS. The rfId must match
 * exactly, so a different sensor firing at the same instant can never absorb
 * another's snapshots.
 */
export function findOrphanTimeline<T extends JoinTimeline>(
  timeline: T[],
  events: JoinEvent[]
): T[] {
  // Grouped by rfId so the scan is per-sensor rather than across every event.
  const byRfId = new Map<string, number[]>();
  for (const ev of events) {
    const list = byRfId.get(ev.rfId);
    if (list) list.push(ev.ms);
    else byRfId.set(ev.rfId, [ev.ms]);
  }

  return timeline.filter((tl) => {
    const candidates = byRfId.get(rfIdOf(tl.id));
    if (!candidates) return true;
    return !candidates.some((ms) => Math.abs(ms - tl.ms) <= JOIN_SKEW_MS);
  });
}
