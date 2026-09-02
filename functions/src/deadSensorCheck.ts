// Task: deadSensorCheck — daily at noon.
//
// Dispatched from doSchedule.ts's single scheduler job (see the table
// there), not an onSchedule() of its own — Cloud Scheduler allows only 3
// free jobs per BILLING ACCOUNT, so every periodic task here is a plain
// async function the one dispatcher invokes.
//
// Two daily maintenance jobs share this one entry, rather than walking the
// same project list twice:
//
//  1. Dead-sensor alerts. For each project + sensor: if lastSeen older than
//     sensor.deadSensorAlertDays and no alert has been sent yet this silence
//     period → Telegram alert once. deadAlertSentAt is set on fire and cleared
//     when the sensor is seen again (onSensorEvent.ts handles the clear on any
//     trigger).
//  2. RTDB event retention — see eventCleanup.ts.

import { FieldValue } from "firebase-admin/firestore";
import { db } from "./admin";
import { Project, Sensor } from "./types";
import { sendTelegram, formatDeadSensor } from "./telegram";
import { cleanupProjectEvents, cutoffFrom } from "./eventCleanup";

export async function deadSensorCheck(): Promise<void> {
  {
    const now = Date.now();

    const projectsSnap = await db.collection("projects").get();

    const cutoff = cutoffFrom(now);

    for (const projectDoc of projectsSnap.docs) {
      const project = { id: projectDoc.id, ...projectDoc.data() } as Project;

      // Runs before the Telegram guard below: retention applies to every
      // project, including those with no Telegram configured. Isolated so a
      // failure here cannot cost the remaining projects their dead-sensor
      // alerts.
      try {
        const removed = await cleanupProjectEvents(project.id, cutoff);
        if (removed > 0) {
          console.log(
            `eventCleanup: removed ${removed} expired events from project=${project.id}`
          );
        }
      } catch (err) {
        console.error(`eventCleanup failed for project=${project.id}`, err);
      }

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
}
