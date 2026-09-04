// Pure decision logic for onDeviceArmStateChange, kept in its own module so
// tests can import it without pulling in ./admin, which needs a live
// Firebase Database URL at module scope. Same split as apiKey.ts /
// mintDeviceToken.ts and alarmLogic.ts / onAlarm.ts.

/**
 * A cloud-initiated arm/disarm writes commands/armed first; the device then
 * echoes the SAME value to state/armed, which would double-notify. When the
 * two already agree the change was cloud-initiated and onArmStateChange has
 * reported it. Only a device-originated change leaves them differing.
 *
 * commandsArmed === null means the node is absent (a project that has never
 * been armed from the app), which cannot be a cloud echo — so notify.
 */
export function shouldSuppressDeviceArmNotification(
  commandsArmed: boolean | null,
  stateArmed: boolean
): boolean {
  if (commandsArmed === null) return false;
  return commandsArmed === stateArmed;
}

/**
 * Timeline label for the event row. The remote is called out by name
 * because "who disarmed my house" is the security-relevant question.
 *
 * This is the FALLBACK: when the identity resolves to a paired remote, the
 * caller uses that remote's real name instead. Matching on the prefix rather
 * than equality so "remote:E45CA" does not silently degrade to "Device".
 */
export function armEventSourceLabel(source: string | null): string {
  return parseArmSource(source).kind === "remote" ? "Remote" : "Device";
}

export type ArmSourceKind = "remote" | "local" | "cloud";

export interface ArmSource {
  kind: ArmSourceKind;
  /** 20-bit remote identity, canonical: uppercase hex, no 0x. */
  identity?: string;
}

/**
 * Decode what `state/armed_by` says about who armed or disarmed.
 *
 * The device writes "remote:E45CA" (see handleRemotePacket in main.cpp), but
 * firmware predating that suffix writes a bare "remote" and is still in the
 * field — so the identity is always optional, never assumed.
 *
 * The identity is canonicalised (uppercase, 0x stripped) because Firestore
 * stores Remote.identity as "0xE45CA". Comparing raw strings across those two
 * spellings silently matches nothing, which would look exactly like an
 * unpaired remote rather than a bug.
 */
export function parseArmSource(source: string | null): ArmSource {
  if (source === "local") return { kind: "local" };
  if (source === "remote") return { kind: "remote" };

  if (source?.startsWith("remote:")) {
    const raw = source.slice("remote:".length).trim();
    const hex = raw.replace(/^0x/i, "").toUpperCase();
    // Non-hex or empty means the value was corrupted in transit. Falling back
    // to the bare-remote shape still reports "a remote did this", which is
    // the security-relevant part; querying for garbage would just match
    // nothing and label the row with it.
    if (!hex || !/^[0-9A-F]+$/.test(hex)) return { kind: "remote" };
    return { kind: "remote", identity: hex };
  }

  // "cloud", absent, or anything unrecognised. Cloud is the safe default: it
  // is the only source that does not claim the device acted on its own.
  return { kind: "cloud" };
}
