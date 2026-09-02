// Cloud Function: onHeartbeat
// Trigger: RTDB onValueWritten on /{projectId}/state/last_seen
//
// Stamps SERVER wall-clock time onto projects/{projectId}.device.lastSeen
// every time the device heartbeats.
//
// WHY A TRIGGER AND NOT A READ: the RTDB value the device writes is its
// UPTIME in seconds (millis()/1000), not epoch — see CloudClient::
// reportHeartbeat(). "33365" tells you the device had been up 9h16m, but
// NOT when that was written, so a scheduled job reading the node cannot
// tell a live device from one that died yesterday. Stamping on write is
// what converts it into a wall-clock liveness signal. (The web UI solves
// the same problem client-side by timestamping the arrival of the update.)
//
// This is deliberately a trigger rather than a polling job: Cloud Scheduler
// allows only 3 free jobs per BILLING ACCOUNT and scheduleTick +
// deadSensorCheck already use two. The offline CHECK itself piggybacks on
// scheduleTick's existing every-minute run — see checkDeviceLiveness().

import { onValueWritten } from "firebase-functions/v2/database";
import { Timestamp } from "firebase-admin/firestore";
import { db } from "./admin";

export const onHeartbeat = onValueWritten(
  {
    ref: "/{projectId}/state/last_seen",
    region: "europe-west1",
  },
  async (event) => {
    const projectId = event.params.projectId;

    // Deletions (e.g. an admin clearing state) are not liveness.
    if (!event.data.after.exists()) return;

    // update() rather than set(): must not clobber the rest of `device`
    // (name, apiKeyHash). Fails if the project doc is missing, which is
    // correct — a heartbeat for an unknown project is not worth creating one.
    try {
      await db
        .doc(`projects/${projectId}`)
        .update({ "device.lastSeen": Timestamp.now() });
    } catch (err) {
      // A heartbeat arrives every ~10s; one lost stamp is harmless and must
      // not turn into a retry storm against a deleted project.
      console.warn(`onHeartbeat: could not stamp project=${projectId}`, err);
    }
  }
);
