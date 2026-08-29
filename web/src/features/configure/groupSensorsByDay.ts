/** Group rows under day headings by when each was last seen.
 *
 *  Generic over the item so the sensor table and any future list can share it;
 *  the caller supplies how to read the timestamp. */

/** Local wall-clock day, so rows either side of midnight never merge. */
function dayKeyOf(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

export interface DayGroup<T> {
  dayKey: string;
  /** A timestamp from the day, for the heading. Null for the never-seen group. */
  date: number | null;
  isToday: boolean;
  /** True for the trailing "never seen" group. */
  isNever: boolean;
  /** Newest first. */
  items: T[];
}

/**
 * Bucket `items` by the local day of their last-seen timestamp: newest day
 * first, newest item first within a day.
 *
 * Items never seen carry no date and cannot be ordered among the others, so
 * they collect into a single group pinned to the end rather than being
 * dropped or sorted to the top.
 */
export function groupItemsByDay<T>(
  items: readonly T[],
  getLastSeen: (item: T) => number | null,
  now: number
): DayGroup<T>[] {
  const todayKey = dayKeyOf(now);
  const byDay = new Map<string, { date: number; items: T[] }>();
  const never: T[] = [];

  for (const item of items) {
    const ts = getLastSeen(item);
    if (ts === null) {
      never.push(item);
      continue;
    }
    const key = dayKeyOf(ts);
    const bucket = byDay.get(key);
    if (bucket) {
      bucket.items.push(item);
      bucket.date = Math.max(bucket.date, ts);
    } else {
      byDay.set(key, { date: ts, items: [item] });
    }
  }

  const groups: DayGroup<T>[] = [...byDay.entries()]
    .map(([dayKey, { date, items: list }]) => ({
      dayKey,
      date,
      isToday: dayKey === todayKey,
      isNever: false,
      items: [...list].sort(
        (a, b) => (getLastSeen(b) ?? 0) - (getLastSeen(a) ?? 0)
      ),
    }))
    .sort((a, b) => (b.date ?? 0) - (a.date ?? 0));

  if (never.length > 0) {
    groups.push({
      dayKey: "never",
      date: null,
      isToday: false,
      isNever: true,
      items: never,
    });
  }

  return groups;
}
