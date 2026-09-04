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
import { Project, AlarmEvent, Remote } from "./types";
import { sendTelegram, formatArmStateBySource } from "./telegram";
import {
  shouldSuppressDeviceArmNotification,
  armEventSourceLabel,
  parseArmSource,
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

    // Read source before anything else: it determines whether the device acted
    // on its own (remote/local) or echoed a cloud command. Written by the
    // device BEFORE state/armed, so it is already present here.
    const sourceSnap = await rtdb.ref(`${projectId}/state/armed_by`).get();
    const source = sourceSnap.exists() ? String(sourceSnap.val()) : null;
    // Parsed, NOT compared with ===. The device now sends "remote:E45CA", and
    // an equality check against "remote" would classify every remote-driven
    // arm/disarm as a cloud echo — skipping the Firestore/commands sync below
    // and leaving the web app permanently out of step with the hardware.
    const sourceKind = parseArmSource(source).kind;
    const isDeviceOriginated = sourceKind === "remote" || sourceKind === "local";

    const commandsSnap = await rtdb.ref(`${projectId}/commands/armed`).get();
    const commandsArmed = commandsSnap.exists()
      ? commandsSnap.val() === true
      : null;

    // Only sync Firestore/commands when the device acted independently of the
    // web. A "cloud" source means it echoed commands/armed — already in sync.
    if (isDeviceOriginated) {
      if (!armed && commandsArmed === true) {
        // Device disarmed via remote/local: clear profile flag and commands.
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

      if (armed && commandsArmed === false) {
        // Device armed via remote: restore last-known profile and sync commands.
        const profileIdSnap = await rtdb
          .ref(`${projectId}/commands/armedProfileId`)
          .get();
        const profileId = profileIdSnap.exists()
          ? String(profileIdSnap.val())
          : null;
        const writes: Promise<unknown>[] = [
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
    }

    if (shouldSuppressDeviceArmNotification(commandsArmed, armed)) return;

    // Resolve WHICH remote, not just that one was used. The device sends only
    // the identity (it has no idea what the user called it), so the name is
    // looked up here — meaning a rename takes effect immediately, with no
    // config push or device round-trip.
    const remoteName = await resolveRemoteName(projectId, source);

    // Mirror to the Firestore timeline. sensorName carries "what this event
    // is about", matching onArmStateChange's use of it for the profile name.
    const alarmEvent: Omit<AlarmEvent, "id"> = {
      sensorId: "",
      rfId: "",
      sensorName: remoteName ?? armEventSourceLabel(source),
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
      formatArmStateBySource(armed, source, remoteName),
      true // arm/disarm is a notice, not a demand for attention
    );
  }
);

/**
 * Map a state/armed_by value to the paired remote's name, or null.
 *
 * Returns null for every non-remote source, for firmware old enough to send a
 * bare "remote", and for an identity matching no paired remote — the caller
 * then falls back to the generic label. A remote can legitimately be unpaired
 * while still transmitting (it was removed in the UI but still exists
 * physically), and that must degrade to "Remote", not to an error.
 */
async function resolveRemoteName(
  projectId: string,
  source: string | null
): Promise<string | null> {
  const parsed = parseArmSource(source);
  if (parsed.kind !== "remote" || !parsed.identity) return null;

  try {
    // Identities are stored as "0xE45CA" but compared canonically, so the
    // match happens in memory rather than as a where() on a spelling that
    // may differ. The collection is capped at 8 remotes (Config::kMaxRemotes),
    // so reading it whole costs nothing.
    const remotesSnap = await db
      .collection(`projects/${projectId}/remotes`)
      .get();
    for (const doc of remotesSnap.docs) {
      const remote = doc.data() as Remote;
      const stored = String(remote.identity ?? "")
        .replace(/^0x/i, "")
        .toUpperCase();
      if (stored === parsed.identity) return remote.name?.trim() || null;
    }
  } catch (err) {
    // Attribution is a nicety; the arm/disarm event itself is not. A failed
    // lookup must not swallow the notification.
    console.warn(
      `onDeviceArmStateChange: remote lookup failed for project=${projectId}`,
      err
    );
  }
  return null;
}
