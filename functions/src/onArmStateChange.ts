// Cloud Function: onArmStateChange
// Trigger: RTDB onValueWritten on /{projectId}/commands/armed
// This is the *intent* channel the web app writes when arming/disarming the
// device (the device echoes it to state/armed once it acts). Mirrors the
// arm/disarm to the Firestore timeline and sends a Telegram notification
// naming the profile that was armed.

import { onValueWritten } from "firebase-functions/v2/database";
import { Timestamp } from "firebase-admin/firestore";
import { db, rtdb } from "./admin";
import { Project, AlarmEvent, Profile, ArmSource } from "./types";
import { sendTelegram, formatArmState, armSourceLabel } from "./telegram";

export const onArmStateChange = onValueWritten(
  { ref: "/{projectId}/commands/armed", region: "europe-west1" },
  async (event) => {
    const after = event.data.after.val();
    const before = event.data.before.val();

    // Skip if value didn't actually change
    if (after === before) return;

    const projectId = event.params.projectId;
    const armed = after === true;

    // If state/armed already matches, this write is a sync from
    // onDeviceArmStateChange (remote arm/disarm restoring consistency), not a
    // fresh user action. Skip timeline + Telegram to avoid duplicating the
    // entry that onDeviceArmStateChange already wrote.
    const stateSnap = await rtdb.ref(`${projectId}/state/armed`).get();
    const stateArmed = stateSnap.exists() ? stateSnap.val() === true : false;
    if (stateArmed === armed) return;

    // Name the profile that is active on the device, when armed. Resolved
    // BEFORE the event write and regardless of Telegram config: the timeline
    // needs it too, and an arm/disarm row with no name is unreadable.
    let profileName: string | undefined;
    let profileId: string | undefined;
    if (armed) {
      const profSnap = await db
        .collection(`projects/${projectId}/profiles`)
        .where("isActiveOnDevice", "==", true)
        .limit(1)
        .get();
      if (!profSnap.empty) {
        profileName = (profSnap.docs[0].data() as Profile).displayName;
        profileId = profSnap.docs[0].id;
        // Store so onDeviceArmStateChange can restore it on remote re-arm.
        await rtdb.ref(`${projectId}/commands/armedProfileId`).set(profileId);
      }
    }

    // WHICH cloud source wrote commands/armed. Four of them do (the web app,
    // scheduleTick, telegramWebhook, and onDeviceArmStateChange's re-sync),
    // and this function sees only the resulting boolean — so each stamps
    // armed_via first. Defaulting to "app" covers a writer that has not been
    // updated: the web app is the overwhelmingly common source, and the point
    // is that the row no longer claims a REMOTE was used.
    const viaSnap = await rtdb.ref(`${projectId}/commands/armed_via`).get();
    const via = viaSnap.exists() ? String(viaSnap.val()) : null;
    const armSource: ArmSource =
      via === "schedule" || via === "telegram" || via === "app" ? via : "app";

    // Mirror to Firestore events. sensorName carries the profile for
    // arm/disarm rows — the timeline's "sensor" column is really "what this
    // event is about", and for an arm event that is the profile. armSource
    // says so explicitly: without it the UI read this profile name as a
    // remote's name and rendered "Remote <profile>".
    const alarmEvent: Omit<AlarmEvent, "id"> = {
      sensorId: "",
      rfId: "",
      sensorName: profileName ?? "",
      eventType: armed ? "armed" : "disarmed",
      batteryLow: false,
      rssi: 0,
      timestamp: Timestamp.now(),
      armSource,
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
      // The source, not a hardcoded "Device": a scheduled arm read "Device
      // armed — Night", which is the same conflation the timeline had.
      formatArmState(armed, armSourceLabel(armSource), profileName),
      true // arm/disarm is a notice, not a demand for attention
    );
  }
);
