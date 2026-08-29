// Cloud Function: onArmStateChange
// Trigger: RTDB onValueWritten on /{projectId}/commands/armed
// This is the *intent* channel the web app writes when arming/disarming the
// device (the device echoes it to state/armed once it acts). Mirrors the
// arm/disarm to the Firestore timeline and sends a Telegram notification
// naming the profile that was armed.

import { onValueWritten } from "firebase-functions/v2/database";
import { Timestamp } from "firebase-admin/firestore";
import { db } from "./admin";
import { Project, AlarmEvent, Profile } from "./types";
import { sendTelegram, formatArmState } from "./telegram";

export const onArmStateChange = onValueWritten(
  { ref: "/{projectId}/commands/armed", region: "europe-west1" },
  async (event) => {
    const after = event.data.after.val();
    const before = event.data.before.val();

    // Skip if value didn't actually change
    if (after === before) return;

    const projectId = event.params.projectId;
    const armed = after === true;

    // Name the profile that is active on the device, when armed. Resolved
    // BEFORE the event write and regardless of Telegram config: the timeline
    // needs it too, and an arm/disarm row with no name is unreadable.
    let profileName: string | undefined;
    if (armed) {
      const profSnap = await db
        .collection(`projects/${projectId}/profiles`)
        .where("isActiveOnDevice", "==", true)
        .limit(1)
        .get();
      if (!profSnap.empty) {
        profileName = (profSnap.docs[0].data() as Profile).displayName;
      }
    }

    // Mirror to Firestore events. sensorName carries the profile for
    // arm/disarm rows — the timeline's "sensor" column is really "what this
    // event is about", and for an arm event that is the profile.
    const alarmEvent: Omit<AlarmEvent, "id"> = {
      sensorId: "",
      rfId: "",
      sensorName: profileName ?? "",
      eventType: armed ? "armed" : "disarmed",
      batteryLow: false,
      rssi: 0,
      timestamp: Timestamp.now(),
    };
    await db.collection(`projects/${projectId}/events`).add(alarmEvent);

    // Send Telegram
    const projectDoc = await db.doc(`projects/${projectId}`).get();
    if (!projectDoc.exists) return;
    const project = { id: projectDoc.id, ...projectDoc.data() } as Project;
    if (!project.telegramBotToken || !project.telegramChatId) return;

    await sendTelegram(
      project.telegramBotToken,
      project.telegramChatId,
      formatArmState(armed, "Device", profileName)
    );
  }
);
