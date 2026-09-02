// Cloud Function: onSirenAddress
// Trigger: RTDB onValueCreated on /{projectId}/events/{rfId}/{timestamp}
//
// When the device boots with a valid siren address it writes a synthetic event
// with rfId "SIREN0" and event "siren_address". This function picks that up
// and mirrors the address into state/siren_base so the web UI can display it.
//
// The device cannot write state/ — its token is scoped to events/ only — so
// a function does the mirroring rather than widening the device's write surface.

import { onValueCreated } from "firebase-functions/v2/database";

export interface SirenAddressEvent {
  event?: string;
  value?: string;
}

// Returns the parsed 24-bit address, or null if this is not a well-formed
// siren-address report. Kept pure so it is unit-testable without any SDK.
export const parseSirenAddressEvent = (
  payload: SirenAddressEvent
): number | null => {
  if (payload.event !== "siren_address" || typeof payload.value !== "string") {
    return null;
  }
  if (!/^0x[0-9A-Fa-f]{6}$/.test(payload.value)) return null;
  const parsed = parseInt(payload.value, 16);
  return isNaN(parsed) ? null : parsed;
};

// The canonical Firestore string form: "0x" + 6 upper-case hex digits. Matches
// what the device reports and the form Remote.identity uses, so a stored value
// can be compared for equality without re-normalising both sides.
//
// Kept pure and separate from the handler so the change-detection below is
// testable without mocking Firestore.
export const canonicalSirenAddress = (address: number): string =>
  `0x${address.toString(16).toUpperCase().padStart(6, "0")}`;

export const onSirenAddress = onValueCreated(
  { ref: "/{projectId}/events/{rfId}/{timestamp}", region: "europe-west1" },
  async (event) => {
    const { rtdb } = await import("./admin");
    const projectId = event.params.projectId;
    const rfId = event.params.rfId;

    if (rfId !== "SIREN0") return;

    const data = event.data.val() as SirenAddressEvent;
    const address = parseSirenAddressEvent(data);
    if (address === null) {
      console.log(`onSirenAddress: ignoring malformed event in ${projectId}`);
      return;
    }

    await rtdb.ref(`${projectId}/state/siren_base`).set(address);
    console.log(
      `onSirenAddress: set state/siren_base = 0x${address.toString(16).toUpperCase()} for ${projectId}`
    );

    // Durable copy in Firestore. state/siren_base above is for DISPLAY; this
    // is the record that survives, and onProjectConfigChange carries it back
    // down as config.s so a device whose EEPROM was wiped re-adopts its own
    // address instead of generating a new one the siren is not paired to.
    //
    // The device-facing config carries the parsed NUMBER, not this string
    // (see buildConfig's sirenKey).
    const canonical = canonicalSirenAddress(address);

    // Only write when it actually changed. The device re-reports its address
    // on EVERY boot, and this doc write triggers onProjectConfigChange ->
    // rebuildConfig; rewriting an identical value would burn a config rebuild
    // (and an RTDB config push to the device) on every single reboot.
    const { db } = await import("./admin");
    const projectRef = db.doc(`projects/${projectId}`);
    const snap = await projectRef.get();
    if (!snap.exists) {
      console.log(`onSirenAddress: project ${projectId} does not exist`);
      return;
    }
    if (snap.data()?.sirenBaseAddress === canonical) return;

    await projectRef.set({ sirenBaseAddress: canonical }, { merge: true });
    console.log(
      `onSirenAddress: persisted sirenBaseAddress = ${canonical} for ${projectId}`
    );
  }
);
