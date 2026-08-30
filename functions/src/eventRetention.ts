// Pure retention policy for RTDB events.
//
// Separated from eventCleanup.ts, which touches the database, so the
// boundary rules are testable without initializing the Admin SDK — the same
// split alarmLogic/alwaysRules use.

/** Events younger than this stay in RTDB; older ones are deleted. */
export const EVENT_RETENTION_MS = 24 * 60 * 60 * 1000;

/** The oldest timestamp still worth keeping, given the current time. */
export function cutoffFrom(nowMs: number): number {
  return nowMs - EVENT_RETENTION_MS;
}

/**
 * The subset of `keys` that have expired — those strictly older than
 * `cutoffMs`.
 *
 * Keys are epoch-millisecond strings. Anything that does not parse as a
 * number is left alone: a malformed key has no decidable age, and guessing
 * risks deleting something we cannot reason about.
 */
export function expiredKeys(keys: string[], cutoffMs: number): string[] {
  return keys.filter((k) => {
    if (k === "") return false;
    const ts = Number(k);
    return Number.isFinite(ts) && ts < cutoffMs;
  });
}
