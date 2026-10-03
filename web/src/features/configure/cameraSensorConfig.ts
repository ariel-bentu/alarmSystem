/** Per-sensor camera config: out-of-sight flag + camera channel.
 *
 *  Pure, like batteryAge.ts and lastSeenFormat.ts beside it, so the label
 *  and input-normalization logic is testable without mounting SensorsTab.
 *
 *  Channel 0 and "no channel set" are deliberately the same thing: both mean
 *  "any camera may cover this sensor" rather than naming one. The valid
 *  range is 1-8 (NVR channel count); anything else — blank, "all", garbage,
 *  out of range — normalizes to undefined so a bad input clears the field
 *  rather than storing nonsense. */

const MIN_CHANNEL = 1;
const MAX_CHANNEL = 8;

/** "All channels" for 0/undefined, else "Camera N". */
export function cameraChannelLabel(channel: number | undefined): string {
  if (!channel) return "All channels";
  return `Camera ${channel}`;
}

/** Parses a <select>/<input> value into a channel number, or undefined for
 *  "all channels" (including unparseable or out-of-range input — a typo
 *  should fall back to "all", not silently store a different channel). */
export function normalizeChannel(raw: string): number | undefined {
  const trimmed = raw.trim().toLowerCase();
  if (trimmed === "" || trimmed === "all") return undefined;
  const n = Number(trimmed);
  if (!Number.isInteger(n) || n < MIN_CHANNEL || n > MAX_CHANNEL) return undefined;
  return n;
}
