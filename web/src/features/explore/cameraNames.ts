// Camera channel names, shared by the Events gallery, the Sensors tab and
// the Camera tab.
//
// Stored as projects/{projectId}.cameraNames — a { "1": "Front door" } map
// keyed by channel number, beside the other NVR settings, because the project
// doc is already loaded everywhere a name is needed. The DEVICE never sees
// these: it captures by channel number, and a name is purely how a human
// reads a channel back.
//
// Pure on purpose (no Firestore, no React), so the label fallback and the
// save-time normalization can be pinned without mounting a page — same
// reasoning as batteryAge.ts and lastSeenFormat.ts.

/** Channel -> display name. Channels with no entry fall back to "Camera N". */
export type CameraNames = Record<string, string>;

/** NVR channel range; the same 1-8 cameraSensorConfig normalizes to. */
export const MIN_CHANNEL = 1;
export const MAX_CHANNEL = 8;

/** Every channel a project can have, named or not. */
export const ALL_CHANNELS: number[] = Array.from(
  { length: MAX_CHANNEL - MIN_CHANNEL + 1 },
  (_, i) => i + MIN_CHANNEL
);

// Long enough for "Back yard by the shed", short enough that a pasted essay
// cannot break the gallery tab strip or a Telegram caption.
const MAX_NAME_LEN = 40;

/** A channel's name, or "Camera N" when it has none. */
export function cameraLabel(
  names: CameraNames | undefined,
  channel: number
): string {
  const name = names?.[String(channel)];
  if (typeof name === "string" && name.trim() !== "") return name.trim();
  return `Camera ${channel}`;
}

/** Cleans an edit-form map into what gets written to Firestore: trimmed,
 *  length-capped, blanks dropped (a cleared input REMOVES the name rather
 *  than storing ""), and only channels in range. */
export function normalizeCameraNames(input: unknown): CameraNames {
  if (!input || typeof input !== "object") return {};
  const out: CameraNames = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    const channel = Number(key);
    if (
      !Number.isInteger(channel) ||
      channel < MIN_CHANNEL ||
      channel > MAX_CHANNEL
    ) {
      continue;
    }
    if (typeof value !== "string") continue;
    const trimmed = value.trim().slice(0, MAX_NAME_LEN);
    if (trimmed === "") continue;
    out[String(channel)] = trimmed;
  }
  return out;
}
