// Pure decision logic for onBoot, split out so tests can import it without
// pulling in ./admin, which needs a live Firebase Database URL at module
// scope. Same split as deviceArmNotify.ts / onDeviceArmStateChange.ts.

/**
 * A boot record as the device writes it to /{projectId}/state/boot.
 * `at` is epoch millis from the device's own clock — see isTrustworthyBootTime.
 */
export interface RtdbBootRecord {
  reason?: unknown;
  at?: unknown;
}

/**
 * The device writes state/boot as soon as the cloud is up, which on a fast
 * boot is BEFORE NTP has synced. Observed on 2026-09-04: `at` was 15000, i.e.
 * 15 seconds past the epoch.
 *
 * Using that value as the event timestamp would file the row in January 1970,
 * where it sorts below every real event and is effectively invisible — the
 * opposite of the point. The same threshold and reasoning already exist in
 * web/src/features/operations/bootReason.ts (isRecentBoot).
 */
export function isTrustworthyBootTime(at: unknown): at is number {
  return typeof at === "number" && at >= 100_000_000_000;
}

/**
 * Pick the timestamp for the boot event: the device's own if it can be
 * trusted, otherwise server-now.
 *
 * Server-now is a good approximation precisely because this runs on an RTDB
 * trigger — the write that fired it just happened.
 */
export function bootEventTimeMs(at: unknown, nowMs: number): number {
  return isTrustworthyBootTime(at) ? at : nowMs;
}

/**
 * Normalise the reason string for storage.
 *
 * Stored raw rather than translated: the UI already owns the mapping from
 * reason to human text (bootReasonKey in bootReason.ts), and translating here
 * would both duplicate it and hard-code English into the database.
 */
export function bootReasonLabel(reason: unknown): string {
  const text = typeof reason === "string" ? reason.trim() : "";
  return text || "unknown";
}
