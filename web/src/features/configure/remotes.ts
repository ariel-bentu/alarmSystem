// Remote-control helpers, kept free of Firebase imports so they are
// directly unit-testable — same split as sirenPairing.ts.

// The button mapping is fixed in firmware (remote_control.cpp) and is NOT
// configurable. Shown in the UI because users will ask what each button
// does — especially "S", which is decoded deliberately but does nothing.
//
// The nibble is one-hot: 0x1/0x2/0x4/0x8. Keep in sync with
// remoteActionFor() in firmware/edge/device/src/remote_control.cpp.
export const REMOTE_BUTTON_LEGEND = [
  { nibble: 0x4, label: "Arm", action: "Arms with the active profile" },
  { nibble: 0x2, label: "Disarm", action: "Disarms" },
  { nibble: 0x8, label: "SOS / bell", action: "Sounds the siren immediately" },
  { nibble: 0x1, label: "S", action: "Not used" },
] as const;

/** Normalise a 20-bit identity to the canonical "0xE45CA" display form. */
export function formatRemoteIdentity(identity: string): string {
  const bare = identity.replace(/^0x/i, "");
  return `0x${bare.toUpperCase().padStart(5, "0")}`;
}

/**
 * Convert a full 24-bit code seen in /events into the 20-bit remote
 * identity by dropping the button nibble.
 *
 * The pairing UI reads candidate codes from /events, where every press
 * appears as a distinct rfId (0xE45CA2, 0xE45CA4, …). All buttons of one
 * remote share the top 20 bits, so this is what collapses them into the
 * single value stored on the remote document.
 *
 * Returns null for anything that is not a parseable hex code (e.g. the
 * "SIREN0" pseudo-sensor).
 */
export function identityFromEventRfId(rfId: string): string | null {
  if (!/^0x[0-9a-f]{6}$/i.test(rfId)) return null;
  const code = parseInt(rfId, 16);
  if (!Number.isFinite(code)) return null;
  return formatRemoteIdentity((code >>> 4).toString(16));
}
