/** Per-sensor camera selection: WHICH NVR channels a sensor's trigger grabs.
 *
 *  Pure, like batteryAge.ts and lastSeenFormat.ts beside it, so the
 *  normalization logic is testable without mounting SensorsTab.
 *
 *  A sensor stores an explicit LIST of channels (`Sensor.cameras`), and that
 *  list is AUTHORITATIVE: empty (or absent) means capture NOTHING for this
 *  sensor, not "capture everything". That is the whole point of the list
 *  replacing the old single `cameraChannel` + `outOfSight` pair — one field
 *  now expresses none / one / several, so there is no separate opt-out flag
 *  to keep in sync. Valid channels are 1-8 (NVR channel count); anything
 *  else is dropped rather than coerced, so a bad value clears a selection
 *  instead of silently storing a different camera.
 *
 *  Display names for these channels live in features/explore/cameraNames.ts
 *  (project-level, shared with the gallery) — not here, because the device
 *  config cares only about numbers. */

import { MAX_CHANNEL, MIN_CHANNEL } from "@/features/explore/cameraNames";

/** Parses arbitrary stored/form input into a sorted, de-duplicated channel
 *  list. Non-arrays, non-integers and out-of-range values are dropped. */
export function normalizeCameras(raw: unknown): number[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<number>();
  for (const entry of raw) {
    if (typeof entry !== "number" || !Number.isInteger(entry)) continue;
    if (entry < MIN_CHANNEL || entry > MAX_CHANNEL) continue;
    seen.add(entry);
  }
  return [...seen].sort((a, b) => a - b);
}

/** Packs a channel list into the one-byte bitmask the device config carries
 *  (`cmask`, index-aligned with `r`): channel N is bit N-1, so channel 1 is
 *  0x01 and channel 8 is 0x80. A zero mask means "capture nothing", which is
 *  also what lets buildConfig omit the array entirely for projects with no
 *  cameras configured. Mirrored by CameraGate::channelsFor() in the
 *  firmware. */
export function toCameraMask(channels: number[]): number {
  let mask = 0;
  for (const channel of normalizeCameras(channels)) {
    mask |= 1 << (channel - 1);
  }
  return mask;
}
