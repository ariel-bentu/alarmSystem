// Cloud Function: onServerArmChange
// Trigger: Firestore onDocumentUpdated on projects/{projectId}
// The server's arm state lives on the project doc (serverArmed). When it flips,
// mirror it to the Firestore timeline and notify Telegram, naming the profile
// that is active on the server.

import { onDocumentUpdated } from "firebase-functions/v2/firestore";
import { Timestamp } from "firebase-admin/firestore";
import { db } from "./admin";
import { Project, AlarmEvent, Profile } from "./types";
import { sendTelegram, formatArmState } from "./telegram";

export const onServerArmChange = onDocumentUpdated(
  { document: "projects/{projectId}", region: "europe-west1" },
  async (event) => {
    const before = event.data?.before.data() as Project | undefined;
    const after = event.data?.after.data() as Project | undefined;
    if (!before || !after) return;

    // Only react to a real change of the server arm flag.
    if (before.serverArmed === after.serverArmed) return;

    const projectId = event.params.projectId;
    const armed = after.serverArmed === true;

    const alarmEvent: Omit<AlarmEvent, "id"> = {
      sensorId: "",
      rfId: "",
      sensorName: "",
      eventType: armed ? "armed" : "disarmed",
      batteryLow: false,
      rssi: 0,
      timestamp: Timestamp.now(),
    };
    await db.collection(`projects/${projectId}/events`).add(alarmEvent);

    if (!after.telegramBotToken || !after.telegramChatId) return;

    let profileName: string | undefined;
    if (armed) {
      const profSnap = await db
        .collection(`projects/${projectId}/profiles`)
        .where("isActiveOnServer", "==", true)
        .limit(1)
        .get();
      if (!profSnap.empty) {
        profileName = (profSnap.docs[0].data() as Profile).displayName;
      }
    }

    await sendTelegram(
      after.telegramBotToken,
      after.telegramChatId,
      formatArmState(armed, "Server", profileName)
    );
  }
);
