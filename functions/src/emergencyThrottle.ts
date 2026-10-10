// One emergency per episode.
//
// Several independent paths may each send severity "alarm" (Pushover priority
// 2: breaks through mute, repeats until acknowledged) for what the owner
// experiences as ONE event: onAlarm for a definite sensor, onSnapshotUploaded
// escalating or raising on a breach verdict — once per sensor/trigger that was
// judged — the pending-alarm sweeper, and onSensorEvent's siren-suppressed
// path. On 2026-10-09 the owner forgot to disarm and came home to three
// separate repeating emergencies (front door, then two judge confirmations of
// the owner on camera), each needing its own acknowledgement.
//
// So the FIRST emergency claims a window and every later one inside it is
// NOT SENT, on any channel (the owner's choice: the events page already shows
// what keeps happening, and a second alert only adds something to cancel).
// Only severity "alarm" is affected. A DISARM ends the window early
// (onDeviceArmStateChange clears the marker), so a fresh arm cycle always
// gets a fresh emergency.
//
// Fail-loud: if the marker cannot be read or written, the emergency is SENT.
// A duplicate is a nuisance; a swallowed alarm is the failure this whole
// system exists to prevent.

import type { Firestore } from "firebase-admin/firestore";

export const EMERGENCY_WINDOW_MS = 5 * 60 * 1000;

export interface EmergencyMarker {
  /** Epoch ms the window's emergency was sent. */
  at?: number;
}

export function emergencyMarkerPath(projectId: string): string {
  return `projects/${projectId}/notifyState/emergency`;
}

/** True when an emergency at `nowMs` may go out at full priority. */
export function emergencyAllowed(
  marker: EmergencyMarker | undefined,
  nowMs: number
): boolean {
  const at = marker?.at;
  if (typeof at !== "number") return true;
  // A marker from the future (clock skew) is treated as expired rather than
  // as an indefinitely long suppression.
  return nowMs - at >= EMERGENCY_WINDOW_MS || nowMs < at;
}

/**
 * Atomically claim the emergency slot. True → send at "alarm"; false → an
 * emergency already went out in this window.
 *
 * A transaction, not read-then-write: the duplicates this exists to stop are
 * concurrent by nature (two cameras' verdicts land within a second).
 */
export async function claimEmergency(
  db: Pick<Firestore, "doc" | "runTransaction">,
  projectId: string,
  nowMs: number
): Promise<boolean> {
  try {
    const ref = db.doc(emergencyMarkerPath(projectId));
    return await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const marker = snap.exists ? (snap.data() as EmergencyMarker) : undefined;
      if (!emergencyAllowed(marker, nowMs)) return false;
      tx.set(ref, { at: nowMs });
      return true;
    });
  } catch (err) {
    console.error(`claimEmergency: failed for project=${projectId} — sending anyway`, err);
    return true;
  }
}

/** End the window: the next emergency goes out at full priority. */
export async function clearEmergency(
  db: Pick<Firestore, "doc">,
  projectId: string
): Promise<void> {
  try {
    await db.doc(emergencyMarkerPath(projectId)).delete();
  } catch (err) {
    // Worst case: one emergency after a quick disarm/re-arm is suppressed.
    console.warn(`clearEmergency: failed for project=${projectId}`, err);
  }
}
