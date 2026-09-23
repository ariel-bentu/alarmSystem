// Task: deadSensorCheck — daily at noon.
//
// Dispatched from doSchedule.ts's single scheduler job (see the table
// there), not an onSchedule() of its own — Cloud Scheduler allows only 3
// free jobs per BILLING ACCOUNT, so every periodic task here is a plain
// async function the one dispatcher invokes.
//
// Three daily maintenance jobs share this one entry, rather than walking the
// same project list three times:
//
//  1. Dead-sensor alerts. For each project + sensor: if lastSeen older than
//     sensor.deadSensorAlertDays and no alert has been sent yet this silence
//     period → Telegram alert once. deadAlertSentAt is set on fire and cleared
//     when the sensor is seen again (onSensorEvent.ts handles the clear on any
//     trigger).
//  2. Stale-battery alerts. If the battery's age (batteryChangedAt, else
//     pairedAt) exceeds project.batteryAlertMonths → Telegram once.
//     batteryAlertSentAt is set on fire and cleared when someone records a
//     new replacement date in the web UI. Decision logic in batteryAgeCheck.ts.
//  3. RTDB event retention — see eventCleanup.ts.
//
// (1) and (2) are independent: a sensor can be both silent and carrying an old
// battery, and gets one message for each, because they mean different things.

import { FieldValue } from "firebase-admin/firestore";
import { db } from "./admin";
import { Project, Sensor } from "./types";
import { sendTelegram, formatDeadSensor, formatStaleBattery } from "./telegram";
import { cleanupProjectEvents, cutoffFrom } from "./eventCleanup";
import {
  shouldAlertStaleBattery,
  batteryStartedAtMs,
  batteryAgeMonths,
  DEFAULT_BATTERY_ALERT_MONTHS,
} from "./batteryAgeCheck";

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

        // Battery age FIRST, and in its own block: the dead-sensor checks
        // below `continue` on several conditions (never seen, alerts
        // disabled, not silent long enough), and a stale battery is worth
        // reporting in every one of those cases. A sensor can be both dead
        // and battery-stale and gets one message for each, because they mean
        // different things: one stopped reporting, the other will soon.
        const startedAtMs = batteryStartedAtMs(sensor);
        if (
          shouldAlertStaleBattery({
            startedAtMs,
            alertSentAt: sensor.batteryAlertSentAt,
            thresholdMonths:
              project.batteryAlertMonths ?? DEFAULT_BATTERY_ALERT_MONTHS,
            nowMs: now,
          })
        ) {
          const months = batteryAgeMonths(startedAtMs as number, now);
          await sendTelegram(
            project.telegramBotToken,
            project.telegramChatId,
            formatStaleBattery(sensor.name, months)
          );
          // Written only after a successful send, so a Telegram failure
          // retries at the next noon instead of silently losing the alert.
          await sensorDoc.ref.update({
            batteryAlertSentAt: FieldValue.serverTimestamp(),
          });
        }

        // --- dead-sensor alerting ---
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
