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
  }
);
