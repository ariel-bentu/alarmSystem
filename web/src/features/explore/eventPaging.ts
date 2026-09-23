// Pure helpers for the Explore timeline's two-layer loading.
//
// The page holds a live listener over today+yesterday and pages older events
// in on demand. These are the boundary between those layers and the merge
// that renders them as one list.

/** The subset of AlarmEvent these helpers read, so tests need no Timestamp. */
interface PageableEvent {
  id: string;
  timestamp: { toMillis: () => number };
}

/**
 * Epoch ms of local midnight at the START of yesterday — the boundary between
 * the live listener (>=) and the paged history (<).
 *
 * Deliberately a calendar step, not `now - 2 * 86_400_000`: a fixed-ms day
 * drifts by an hour across a DST shift and would land at 23:00 or 01:00 of the
 * wrong day, cutting a day group in half. setDate(-1) stays on local midnight.
 */
export function liveWindowStart(now: number): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - 1);
  return d.getTime();
}

/**
 * Combine the live and history layers into one newest-first list.
 *
 * The queries are disjoint by construction, but an event arriving while a page
 * is in flight can land in both; deduping by id keeps React keys unique. The
 * live copy wins, being the one that stays subscribed to further updates.
 */
export function mergeEventPages<T extends PageableEvent>(
  live: readonly T[],
  history: readonly T[]
): T[] {
  const byId = new Map<string, T>();
  for (const ev of history) byId.set(ev.id, ev);
  for (const ev of live) byId.set(ev.id, ev);

  return [...byId.values()].sort(
    (a, b) => b.timestamp.toMillis() - a.timestamp.toMillis()
  );
}
