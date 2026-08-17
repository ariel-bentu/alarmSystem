// Cloud Function: deadSensorCheck
// Trigger: scheduled every hour.
// For each project + sensor: if lastSeen older than threshold → Telegram alert.

import { onSchedule } from "firebase-functions/v2/scheduler";
import { db } from "./admin";
import { Project, Sensor } from "./types";
import { sendTelegram, formatDeadSensor } from "./telegram";

const DEFAULT_DEAD_THRESHOLD_MS = 24 * 60 * 60 * 1000; // 24 hours

export const deadSensorCheck = onSchedule(
  { schedule: "every 1 hours", region: "europe-west1" },
  async (_event) => {
    const now = Date.now();

    const projectsSnap = await db.collection("projects").get();

    for (const projectDoc of projectsSnap.docs) {
      const project = { id: projectDoc.id, ...projectDoc.data() } as Project;

      if (!project.telegramBotToken || !project.telegramChatId) continue;

      const sensorsSnap = await db
        .collection(`projects/${project.id}/sensors`)
        .get();

      for (const sensorDoc of sensorsSnap.docs) {
        const sensor = { id: sensorDoc.id, ...sensorDoc.data() } as Sensor;

        if (sensor.lastSeen === null) continue; // Never seen — skip (newly paired)

        const silentMs = now - sensor.lastSeen.toMillis();
        if (silentMs > DEFAULT_DEAD_THRESHOLD_MS) {
          const hoursSilent = Math.round(silentMs / (60 * 60 * 1000));
          const msg = formatDeadSensor(sensor.name, hoursSilent);
          await sendTelegram(project.telegramBotToken, project.telegramChatId, msg);
        }
      }
    }
  }
);
