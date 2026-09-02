// Device offline / back-online alerting.
//
// Called from scheduleTick's every-minute run rather than from a scheduled
// function of its own: Cloud Scheduler allows only 3 free jobs per BILLING
// ACCOUNT, and scheduleTick + deadSensorCheck already take two. The armed
// threshold is 5 minutes, so minute granularity is exactly what this needs
// and scheduleTick already provides it.
//
// The decision logic lives in deviceOnline.ts (pure, unit-tested); this file
// is the Firestore/Telegram plumbing around it.

import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { db, rtdb } from "./admin";
import { Project } from "./types";
import {
  sendTelegram,
  formatDeviceOffline,
  formatDeviceBackOnline,
} from "./telegram";
import { decideOfflineAction, formatSilence } from "./deviceOnline";

/**
 * Check every project's device liveness and alert on transitions.
 *
 * Isolated per project: one project's Telegram failure must not cost the
 * others their alerts, exactly as deadSensorCheck isolates event cleanup.
 */
export async function checkDeviceLiveness(nowMs: number): Promise<void> {
  const projectsSnap = await db.collection("projects").get();

  for (const projectDoc of projectsSnap.docs) {
    const project = { id: projectDoc.id, ...projectDoc.data() } as Project;

    // No Telegram configured means nowhere to send. Skipped before any RTDB
    // read so an unconfigured project costs nothing.
    if (!project.telegramBotToken || !project.telegramChatId) continue;

    try {
      const lastSeen = project.device?.lastSeen ?? null;
      const alertSent = Boolean(project.device?.offlineAlertSentAt);

      // Device-side armed state selects the threshold — this is about
      // whether the PREMISES are unwatched, so the device's own arm state is
      // the right question, not serverArmed.
      const armedSnap = await rtdb.ref(`${project.id}/state/armed`).get();
      const armed = armedSnap.val() === true;

      const action = decideOfflineAction({
        lastSeenMs: lastSeen ? lastSeen.toMillis() : null,
        alertSent,
        armed,
        nowMs,
      });

      if (action === "none") continue;

      // Safe: decideOfflineAction only returns an alert action when
      // lastSeenMs is non-null.
      const silence = formatSilence(nowMs - lastSeen!.toMillis());

      if (action === "alert_offline") {
        await sendTelegram(
          project.telegramBotToken,
          project.telegramChatId,
          formatDeviceOffline(silence, armed)
        );
        // Latch AFTER a successful send, so a Telegram outage retries next
        // minute instead of silently swallowing the only warning.
        await projectDoc.ref.update({
          "device.offlineAlertSentAt": Timestamp.fromMillis(nowMs),
        });
        console.log(
          `deviceLiveness: project=${project.id} OFFLINE ${silence} armed=${armed}`
        );
      } else {
        // Back online. `silence` here is time since the last heartbeat,
        // which for a recovered device is small — report the outage length
        // from when we flagged it instead.
        const flaggedAt = project.device?.offlineAlertSentAt;
        const outage = flaggedAt
          ? formatSilence(nowMs - flaggedAt.toMillis())
          : silence;
        await sendTelegram(
          project.telegramBotToken,
          project.telegramChatId,
          formatDeviceBackOnline(outage)
        );
        await projectDoc.ref.update({
          "device.offlineAlertSentAt": FieldValue.delete(),
        });
        console.log(
          `deviceLiveness: project=${project.id} BACK ONLINE after ${outage}`
        );
      }
    } catch (err) {
      console.error(`deviceLiveness failed for project=${project.id}`, err);
    }
  }
}
