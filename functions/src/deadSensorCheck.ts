// Cloud Function: deadSensorCheck
// Trigger: scheduled daily at noon.
// For each project + sensor: if lastSeen older than sensor.deadSensorAlertDays
// and no alert has been sent yet this silence period → Telegram alert once.
// deadAlertSentAt is set on fire and cleared when the sensor is seen again
// (onSensorEvent.ts handles the clear on any trigger).

import { onSchedule } from "firebase-functions/v2/scheduler";
import { FieldValue } from "firebase-admin/firestore";
import { db } from "./admin";
import { Project, Sensor } from "./types";
import { sendTelegram, formatDeadSensor } from "./telegram";

export const deadSensorCheck = onSchedule(
  { schedule: "every day 12:00", region: "europe-west1" },
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

        const alertDays = sensor.deadSensorAlertDays ?? -1;
        if (alertDays < 0) continue; // Never alert for this sensor

        const thresholdMs = alertDays * 24 * 60 * 60 * 1000;
        const silentMs = now - sensor.lastSeen.toMillis();
        if (silentMs <= thresholdMs) continue; // Not silent long enough

        if (sensor.deadAlertSentAt !== null) continue; // Already alerted this period

        const hoursSilent = Math.round(silentMs / (60 * 60 * 1000));
        const msg = formatDeadSensor(sensor.name, hoursSilent);
        await sendTelegram(project.telegramBotToken, project.telegramChatId, msg);
        await sensorDoc.ref.update({ deadAlertSentAt: FieldValue.serverTimestamp() });
      }
    }
  }
);
