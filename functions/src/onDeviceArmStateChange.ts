// Cloud Function: onDeviceArmStateChange
// Trigger: RTDB onValueWritten on /{projectId}/state/armed
//
// state/armed is the ECHO channel: the device writes it after it acts,
// whatever the source. onArmStateChange covers only commands/armed, the
// web app's INTENT channel, so before this function a disarm originating
// on the device (local web UI, remote control) produced no Telegram and no
// timeline entry at all — it was completely silent.
//
// That silence is why this exists: a fixed-code remote is replayable, and
// the only available mitigation is that a disarm is never unattributed.

import { onValueWritten } from "firebase-functions/v2/database";
import { Timestamp } from "firebase-admin/firestore";
import { db, rtdb } from "./admin";
import { Project, AlarmEvent } from "./types";
import { sendTelegram, formatArmStateBySource } from "./telegram";
import {
  shouldSuppressDeviceArmNotification,
  armEventSourceLabel,
} from "./deviceArmNotify";

export const onDeviceArmStateChange = onValueWritten(
  { ref: "/{projectId}/state/armed", region: "europe-west1" },
  async (event) => {
    const after = event.data.after.val();
    const before = event.data.before.val();

    // Skip if value didn't actually change
    if (after === before) return;

    const projectId = event.params.projectId;
    const armed = after === true;

    const commandsSnap = await rtdb.ref(`${projectId}/commands/armed`).get();
    const commandsArmed = commandsSnap.exists()
      ? commandsSnap.val() === true
      : null;

    // When the device disarms by a source that bypassed the web intent channel
    // (remote control, local web UI), commands/armed is still true and
    // isActiveOnDevice on the profile is still true, so the web UI shows
    // "Armed" even though the device is disarmed. Sync Firestore here so the
    // UI reflects reality.
    if (!armed && commandsArmed === true) {
      const profilesSnap = await db
        .collection(`projects/${projectId}/profiles`)
        .where("isActiveOnDevice", "==", true)
        .get();
      const batch = db.batch();
      for (const doc of profilesSnap.docs) {
        batch.update(doc.ref, { isActiveOnDevice: false });
      }
      await Promise.all([
        batch.commit(),
        rtdb.ref(`${projectId}/commands/armed`).set(false),
      ]);
    }

    // When the device arms via remote (bypassing the web), commands/armed is
    // false but state/armed just flipped true. Restore isActiveOnDevice on the
    // last profile the web armed with (stored in commands/armedProfileId by
    // onArmStateChange) so the UI grid highlights the right profile.
    if (armed && commandsArmed === false) {
      const profileIdSnap = await rtdb
        .ref(`${projectId}/commands/armedProfileId`)
        .get();
      const profileId = profileIdSnap.exists()
        ? String(profileIdSnap.val())
        : null;
      const writes: Promise<unknown>[] = [
        // Keep commands/armed in sync so a subsequent web disarm sees a
        // false→false no-op and actually delivers the command to the device.
        rtdb.ref(`${projectId}/commands/armed`).set(true),
      ];
      if (profileId) {
        writes.push(
          db
            .doc(`projects/${projectId}/profiles/${profileId}`)
            .update({ isActiveOnDevice: true })
        );
      }
      await Promise.all(writes);
    }

    if (shouldSuppressDeviceArmNotification(commandsArmed, armed)) return;

    // Written by the device in the same update as state/armed, and written
    // FIRST, so it is already present when this fires. Absent for older
    // firmware, which falls back to a generic "Device armed/disarmed".
    const sourceSnap = await rtdb.ref(`${projectId}/state/armed_by`).get();
    const source = sourceSnap.exists() ? String(sourceSnap.val()) : null;

    // Mirror to the Firestore timeline. sensorName carries "what this event
    // is about", matching onArmStateChange's use of it for the profile name.
    const alarmEvent: Omit<AlarmEvent, "id"> = {
      sensorId: "",
      rfId: "",
      sensorName: armEventSourceLabel(source),
      eventType: armed ? "armed" : "disarmed",
      batteryLow: false,
      rssi: 0,
      timestamp: Timestamp.now(),
    };
    await db.collection(`projects/${projectId}/events`).add(alarmEvent);

    const projectDoc = await db.doc(`projects/${projectId}`).get();
    if (!projectDoc.exists) return;
    const project = { id: projectDoc.id, ...projectDoc.data() } as Project;
    if (!project.telegramBotToken || !project.telegramChatId) return;

    await sendTelegram(
      project.telegramBotToken,
      project.telegramChatId,
      formatArmStateBySource(armed, source),
      true // arm/disarm is a notice, not a demand for attention
    );
  }
);
