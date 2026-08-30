// Pure wall-clock -> instant conversion for schedules. The ONLY place a
// "23:00" becomes a Date. No Firestore, no ambient clock: `after` is always
// injected so tests can pin time exactly.
//
// Node 20 on Cloud Functions ships full ICU, so Intl resolves zone offsets
// without a date library — deliberately, to keep functions/ at two runtime
// dependencies.

import { Schedule } from "./types";

/** Offset of `instant` in `tz`, in minutes east of UTC. */
function offsetMinutes(instant: Date, tz: string): number {
  // 'en-US' with an explicit part list gives a stable, parseable breakdown.
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts = dtf.formatToParts(instant);
  const get = (type: string) =>
    Number(parts.find((p) => p.type === type)?.value ?? "0");
  // Hour 24 appears at midnight in some ICU versions; normalise to 0.
  const hour = get("hour") % 24;
  const asUtc = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    hour,
    get("minute"),
    get("second")
  );
  return (asUtc - instant.getTime()) / 60000;
}

/**
 * The instant at which local wall-clock `timeStr` occurs on local `dateStr`
 * in `tz`.
 *
 * DST rules, decided in the design doc rather than left to accident:
 * - Skipped time (spring forward): the naive guess lands in the gap. The two
 *   passes disagree, and taking the later yields the instant the clock jumps
 *   to, so the edge fires rather than vanishing.
 * - Repeated time (autumn): the FIRST occurrence is returned, so an edge
 *   never fires twice.
 */
export function zonedTimeToUtc(
  dateStr: string,
  timeStr: string,
  tz: string
): Date {
  const [y, m, d] = dateStr.split("-").map(Number);
  const [hh, mm] = timeStr.split(":").map(Number);
  const naive = Date.UTC(y, m - 1, d, hh, mm, 0);

  // Probe the offsets in effect a day either side. In an overlap these are
  // the two candidate offsets for the same wall clock; outside a transition
  // they are equal and the whole thing collapses to one candidate.
  //
  // Probing BOTH is what makes the fire-once rule work. Iterating
  // guess-then-correct instead converges on the LATER occurrence and never
  // visits the earlier one, because the corrected instant is already
  // self-consistent under the post-transition offset.
  const offsets = [
    offsetMinutes(new Date(naive - 86400000), tz),
    offsetMinutes(new Date(naive), tz),
    offsetMinutes(new Date(naive + 86400000), tz),
  ];

  // A candidate is real when its local time re-renders as the wall clock we
  // asked for. In a gap none do; in an overlap two do.
  const valid = offsets
    .map((o) => naive - o * 60000)
    .filter((t) => offsetMinutes(new Date(t), tz) * 60000 + t === naive)
    .sort((a, b) => a - b);

  if (valid.length > 0) return new Date(valid[0]); // first occurrence

  // Gap: the wall clock never happens. Fire at the instant the clock jumps
  // forward, so the edge is not silently lost.
  //
  // That instant is NOT simply the latest candidate — applying the
  // pre-transition offset to a skipped 02:30 lands 30 minutes past the jump.
  // Binary-search the offset change, which the candidates bracket. Zone
  // transitions land on a minute boundary, so search at minute resolution:
  // offsetMinutes is itself minute-truncated, and searching finer makes the
  // comparison unstable near the boundary (it converges a few minutes early).
  const MIN = 60000;
  let a = Math.floor(Math.min(...offsets.map((o) => naive - o * 60000)) / MIN);
  let b = Math.ceil(Math.max(...offsets.map((o) => naive - o * 60000)) / MIN);
  const offAtLo = offsetMinutes(new Date(a * MIN), tz);
  while (b - a > 1) {
    const mid = a + Math.floor((b - a) / 2);
    if (offsetMinutes(new Date(mid * MIN), tz) === offAtLo) a = mid;
    else b = mid;
  }
  return new Date(b * MIN);
}

/** Local calendar date in `tz` for an instant, as "YYYY-MM-DD". */
function localDateStr(instant: Date, tz: string): string {
  const dtf = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return dtf.format(instant); // en-CA formats as YYYY-MM-DD
}

/** Day of week (0=Sun) for a "YYYY-MM-DD" local date string. */
function dayOfWeek(dateStr: string): number {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/** Add `n` days to a "YYYY-MM-DD" string, returning the same format. */
function addDays(dateStr: string, n: number): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  const next = new Date(Date.UTC(y, m - 1, d + n));
  return next.toISOString().slice(0, 10);
}

/**
 * First instant strictly after `after` at which `timeStr` occurs on a day
 * permitted by the schedule. Returns null for a one-time schedule whose
 * date has passed.
 */
function nextInstantFor(
  schedule: Schedule,
  timeStr: string,
  tz: string,
  after: Date
): Date | null {
  if (schedule.date) {
    const instant = zonedTimeToUtc(schedule.date, timeStr, tz);
    return instant.getTime() > after.getTime() ? instant : null;
  }
  if (schedule.days.length === 0) return null;

  // Start from the local date of `after` and walk forward. 8 days covers a
  // full week plus the case where today's time has already passed.
  let dateStr = localDateStr(after, tz);
  for (let i = 0; i < 8; i++) {
    if (schedule.days.includes(dayOfWeek(dateStr))) {
      const instant = zonedTimeToUtc(dateStr, timeStr, tz);
      if (instant.getTime() > after.getTime()) return instant;
    }
    dateStr = addDays(dateStr, 1);
  }
  return null;
}

/** Next arm instant, or null for an arm-less or expired one-time window. */
export function nextArmInstant(
  schedule: Schedule,
  tz: string,
  after: Date
): Date | null {
  if (!schedule.armTime) return null;
  return nextInstantFor(schedule, schedule.armTime, tz, after);
}

/**
 * Next disarm instant.
 *
 * When the window has an arm edge, the disarm is derived FORWARD from it, so
 * a Fri 23:00 -> 07:00 window disarms on Saturday with no wraparound flag.
 * When it does not, `disarmTime` resolves against `days`/`date` directly.
 */
export function nextDisarmInstant(
  schedule: Schedule,
  tz: string,
  armAt: Date | null,
  after: Date
): Date | null {
  if (!armAt) return nextInstantFor(schedule, schedule.disarmTime, tz, after);

  const armDate = localDateStr(armAt, tz);
  const sameDay = zonedTimeToUtc(armDate, schedule.disarmTime, tz);
  if (sameDay.getTime() > armAt.getTime()) return sameDay;
  return zonedTimeToUtc(addDays(armDate, 1), schedule.disarmTime, tz);
}
