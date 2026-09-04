// Cloud Function: onAlarm
// Trigger: RTDB onValueWritten on /{projectId}/state/siren_active
// When value becomes true → send urgent Telegram alert naming the cause.
//
// This is the alarm notifier for every alarm that sounds the siren, whether
// the server evaluated it (onSensorEvent) or the device did. Both writers
// record /{projectId}/state/alarm_cause first; see alarmCause.ts for the two
// shapes and why the device's differs.

import { onValueWritten } from "firebase-functions/v2/database";
import { Timestamp } from "firebase-admin/firestore";
import { db, rtdb } from "./admin";
import { AlarmEvent, Project, Rule, Sensor } from "./types";
import { sendTelegram, formatAlarm } from "./telegram";
import { isCauseFresh, parseCause, resolveCauseLabel } from "./alarmCause";

export const onAlarm = onValueWritten(
  { ref: "/{projectId}/state/siren_active", region: "europe-west1" },
  async (event) => {
    const after = event.data.after.val();
    const before = event.data.before.val();

    // Only act when value transitions to true
    if (after !== true || before === true) return;

    const projectId = event.params.projectId;

    // Resolved BEFORE the Telegram gate below: the timeline row must be
    // written whether or not this project has Telegram configured. The alarm
    // that actually sounded the siren is the single most important thing the
    // event list can show, and it was previously missing from it entirely —
    // only sensor triggers and arm/disarm were ever mirrored.
    const label = await resolveLabel(projectId);

    try {
      const alarmEvent: Omit<AlarmEvent, "id"> = {
        sensorId: "",
        rfId: "",
        // The cause if we could name one ("Front door", "SOS (remote)"),
        // otherwise blank — which the UI renders as the muted "System".
        sensorName: label ?? "",
        eventType: "alarm",
        batteryLow: false,
        rssi: 0,
        timestamp: Timestamp.now(),
      };
      await db.collection(`projects/${projectId}/events`).add(alarmEvent);
    } catch (err) {
      // Never let a timeline write cost the actual alarm notification.
      console.warn(`onAlarm: could not record event for project=${projectId}`, err);
    }

    const projectDoc = await db.doc(`projects/${projectId}`).get();
    if (!projectDoc.exists) return;
    const project = { id: projectDoc.id, ...projectDoc.data() } as Project;

    if (!project.telegramBotToken || !project.telegramChatId) return;

    const message = label ? formatAlarm(label) : "🚨 Alarm triggered!";

    await sendTelegram(project.telegramBotToken, project.telegramChatId, message);
  }
);

/**
 * Read the recorded cause and turn it into a display label, or null if there
 * is no usable one (caller then sends the generic message). A server-written
 * cause already carries its label; a device-written one needs the sensor and
 * rule names looked up here.
 */
async function resolveLabel(projectId: string): Promise<string | null> {
  const causeSnap = await rtdb.ref(`${projectId}/state/alarm_cause`).get();
  const cause = parseCause(causeSnap.val());
  if (!cause || !isCauseFresh(cause, Date.now())) return null;

  // A server-written label needs no lookups.
  if (cause.label?.trim()) return cause.label.trim();
  if (!cause.rfId?.trim()) return null;

  // Device-written: map rfId → sensor, then find a rule covering that sensor.
  const sensorsSnap = await db.collection(`projects/${projectId}/sensors`).get();
  const sensorNamesByRfId: Record<string, string> = {};
  const sensorIdsByRfId: Record<string, string> = {};
  for (const doc of sensorsSnap.docs) {
    const sensor = { id: doc.id, ...doc.data() } as Sensor;
    sensorNamesByRfId[sensor.rfId] = sensor.name;
    sensorIdsByRfId[sensor.rfId] = sensor.id;
  }

  // Rules come from the profile the DEVICE is running, which is the one that
  // evaluated this alarm — not the server's active profile.
  let rules: Rule[] = [];
  const profileSnap = await db
    .collection(`projects/${projectId}/profiles`)
    .where("isActiveOnDevice", "==", true)
    .limit(1)
    .get();
  if (!profileSnap.empty) {
    const rulesSnap = await db
      .collection(`projects/${projectId}/profiles/${profileSnap.docs[0].id}/rules`)
      .get();
    rules = rulesSnap.docs.map((d) => ({ id: d.id, ...d.data() } as Rule));
  }

  return resolveCauseLabel(cause, rules, sensorNamesByRfId, sensorIdsByRfId);
}
