// Cloud Function: onAlarm
// Trigger: RTDB onValueWritten on /{projectId}/state/siren_active
// When value becomes true → send urgent Telegram alert.

import { onValueWritten } from "firebase-functions/v2/database";
import { db } from "./admin";
import { Project } from "./types";
import { sendTelegram } from "./telegram";

export const onAlarm = onValueWritten(
  { ref: "/{projectId}/state/siren_active", region: "europe-west1" },
  async (event) => {
    const after = event.data.after.val();
    const before = event.data.before.val();

    // Only act when value transitions to true
    if (after !== true || before === true) return;

    const projectId = event.params.projectId;

    const projectDoc = await db.doc(`projects/${projectId}`).get();
    if (!projectDoc.exists) return;
    const project = { id: projectDoc.id, ...projectDoc.data() } as Project;

    if (project.telegramBotToken && project.telegramChatId) {
      await sendTelegram(
        project.telegramBotToken,
        project.telegramChatId,
        "🚨 Alarm triggered!"
      );
    }
  }
);
