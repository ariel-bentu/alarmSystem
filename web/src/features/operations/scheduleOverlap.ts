// Same-side overlap detection, used to WARN on save — never to block.
// Overlapping edges are last-write-wins by design (see the design doc): each
// edge is independent, so no window owns a side. The warning exists to catch
// the genuine mistake, not to enforce a policy.

import { minutesOf } from "./scheduleFormat";
import type { Schedule } from "@/types";

const DAY_MINUTES = 24 * 60;

/** Intervals a window covers, split at midnight when it wraps. */
function intervals(s: Schedule): Array<[number, number]> {
  const start = s.armTime ? minutesOf(s.armTime) : 0;
  const end = minutesOf(s.disarmTime);
  if (end > start) return [[start, end]];
  // Wraps midnight: the tail of the day plus the head of the next.
  return [
    [start, DAY_MINUTES],
    [0, end],
  ];
}

function intervalsIntersect(
  a: Array<[number, number]>,
  b: Array<[number, number]>
): boolean {
  return a.some(([as, ae]) => b.some(([bs, be]) => as < be && bs < ae));
}

function sharesADay(a: Schedule, b: Schedule): boolean {
  if (a.date || b.date) return a.date === b.date;
  return a.days.some((d) => b.days.includes(d));
}

export function overlaps(a: Schedule, b: Schedule): boolean {
  if (a.id === b.id) return false;
  if (a.side !== b.side) return false;
  if (!sharesADay(a, b)) return false;
  return intervalsIntersect(intervals(a), intervals(b));
}

export function findOverlaps(
  candidate: Schedule,
  existing: Schedule[]
): Schedule[] {
  return existing.filter((e) => e.enabled && overlaps(candidate, e));
}
