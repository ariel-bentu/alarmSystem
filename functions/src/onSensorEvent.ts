// Cloud Function: onSensorEvent
// Trigger: RTDB onValueCreated on /{projectId}/events/{rfId}/{timestamp}

import { onValueCreated } from "firebase-functions/v2/database";
import { Timestamp } from "firebase-admin/firestore";
import { db, rtdb } from "./admin";
import { AlarmEvent, EventType, Project, Sensor, Rule } from "./types";
import { sendTelegram, formatSensorAlert, formatAlarm } from "./telegram";
import { evaluateRules } from "./alarmLogic";

export const onSensorEvent = onValueCreated(
  { ref: "/{projectId}/events/{rfId}/{timestamp}", region: "europe-west1" },
  async (event) => {
    const projectId = event.params.projectId;
    const rfId = event.params.rfId;
    const timestamp = Number(event.params.timestamp);
    const data = event.data.val() as { event: string; battery_low: boolean; rssi: number };

    // (a) Look up sensor by rfId
    const sensorSnap = await db
      .collection(`projects/${projectId}/sensors`)
      .where("rfId", "==", rfId)
      .limit(1)
      .get();

    if (sensorSnap.empty) {
      // Deliberately NOT mirrored to Firestore: an unpaired sensor has no
      // name, no profile membership and no rules, so there is nothing
      // meaningful to write to the timeline. The RTDB event itself is left
      // in place, which is what makes pairing possible — the web UI's
      // Sensors tab reads /{projectId}/events directly and lists any rfId
      // with no matching Firestore sensor as "unrecognised", ready to pair
      // (see web/src/features/configure/unknownSensors.ts). Dropping the
      // RTDB node here would make new sensors impossible to discover.
      console.log(
        `Unpaired sensor rfId=${rfId} in project=${projectId}: kept in RTDB ` +
          `for pairing, not mirrored to Firestore.`
      );
      return;
    }

    const sensorDoc = sensorSnap.docs[0];
    const sensor = { id: sensorDoc.id, ...sensorDoc.data() } as Sensor;

    // Determine event type
    let eventType: EventType = "trigger";
    if (data.event === "tamper") eventType = "tamper";
    else if (data.battery_low) eventType = "battery_low";

    // (b) Mirror to Firestore events
    const alarmEvent: Omit<AlarmEvent, "id"> = {
      sensorId: sensor.id,
      rfId,
      sensorName: sensor.name,
      eventType,
      batteryLow: data.battery_low,
      rssi: data.rssi,
      timestamp: Timestamp.fromMillis(timestamp),
    };

    const eventRef = await db
      .collection(`projects/${projectId}/events`)
      .add(alarmEvent);

    // (c) Update sensor.lastSeen and batteryStatus
    const updates: Record<string, unknown> = { lastSeen: Timestamp.fromMillis(timestamp) };
    if (data.battery_low) updates.batteryStatus = "low";
    await sensorDoc.ref.update(updates);

    // (d) Get project for Telegram config
    const projectDoc = await db.doc(`projects/${projectId}`).get();
    if (!projectDoc.exists) return;
    const project = { id: projectDoc.id, ...projectDoc.data() } as Project;

    // Send Telegram alert per sensor trigger, only if enabled for this project.
    // Battery-low and tamper always notify (safety), regardless of the toggle.
    const alwaysNotify = eventType === "battery_low" || eventType === "tamper";
    if (
      (project.notifyEverySensorTrigger !== false || alwaysNotify) &&
      project.telegramBotToken &&
      project.telegramChatId
    ) {
      const msg = formatSensorAlert(sensor.name, eventType);
      await sendTelegram(project.telegramBotToken, project.telegramChatId, msg);
    }

    // (e) Server-side alarm evaluation
    if (project.serverArmed) {
      // Find active server profile
      const profileSnap = await db
        .collection(`projects/${projectId}/profiles`)
        .where("isActiveOnServer", "==", true)
        .limit(1)
        .get();

      if (!profileSnap.empty) {
        const profileDoc = profileSnap.docs[0];

        // Get rules for this profile
        const rulesSnap = await db
          .collection(`projects/${projectId}/profiles/${profileDoc.id}/rules`)
          .get();
        const rules: Rule[] = rulesSnap.docs.map((d) => ({ id: d.id, ...d.data() } as Rule));

        // Get recent events for evaluation (last 5 minutes). Query on timestamp
        // only (single-field, auto-indexed) and filter by sensor in memory to
        // avoid needing a composite index. For multi_sensor rules we need other
        // sensors' events too, so we do NOT filter by sensorId in the query.
        const fiveMinAgo = Timestamp.fromMillis(timestamp - 5 * 60 * 1000);
        const recentSnap = await db
          .collection(`projects/${projectId}/events`)
          .where("timestamp", ">=", fiveMinAgo)
          .orderBy("timestamp", "desc")
          .limit(100)
          .get();

        const recentEvents: AlarmEvent[] = recentSnap.docs
          .filter((d) => d.id !== eventRef.id) // exclude the event we just wrote
          .map((d) => ({ id: d.id, ...d.data() } as AlarmEvent));

        const fullEvent: AlarmEvent = { id: eventRef.id, ...alarmEvent };
        const result = evaluateRules(rules, fullEvent, recentEvents, timestamp);

        if (result.triggered) {
          // If entry_delay, we note it but still fire (server doesn't implement delay timer in v1)
          if (project.serverActions.triggerSiren) {
            await rtdb.ref(`${projectId}/state/siren_active`).set(true);
          }
          if (project.serverActions.sendTelegram && project.telegramBotToken && project.telegramChatId) {
            // Use the rule/condition name; fall back to the sensor name when
            // the rule is unnamed.
            const label = result.ruleName || sensor.name;
            const alarmMsg = formatAlarm(label);
            await sendTelegram(project.telegramBotToken, project.telegramChatId, alarmMsg);
          }
        }
      }
    }
  }
);
