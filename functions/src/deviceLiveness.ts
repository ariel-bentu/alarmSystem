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
import { AlarmEvent, EventType, Project } from "./types";
import { formatDeviceOffline, formatDeviceBackOnline } from "./telegram";
import { notify } from "./notify";
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

    // No credential gate here: notify() owns channel resolution, and skipping
    // on Telegram credentials alone would silently exclude every project that
    // uses Pushover only.

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
        await notify(project.id, project, {
          text: formatDeviceOffline(silence, armed),
          severity: "loud",
          title: "Device offline",
        });
        // Latch AFTER a successful send, so a notification outage retries
        // next minute instead of silently swallowing the only warning.
        await projectDoc.ref.update({
          "device.offlineAlertSentAt": Timestamp.fromMillis(nowMs),
        });
        await recordLifecycleEvent(
          project.id,
          "device_offline",
          armed ? `Offline ${silence} while armed` : `Offline ${silence}`,
          nowMs
        );
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
        await notify(project.id, project, {
          // A recovery message is informational. Under the Pushover mapping a
          // "loud" severity would fire a Critical Alert through a muted phone
          // to say everything is fine, so this is deliberately a notice.
          text: formatDeviceBackOnline(outage),
          severity: "notice",
        });
        await projectDoc.ref.update({
          "device.offlineAlertSentAt": FieldValue.delete(),
        });
        await recordLifecycleEvent(
          project.id,
          "device_online",
          `Back online after ${outage}`,
          nowMs
        );
        console.log(
          `deviceLiveness: project=${project.id} BACK ONLINE after ${outage}`
        );
      }
    } catch (err) {
      console.error(`deviceLiveness failed for project=${project.id}`, err);
    }
  }
}

/**
 * Add a controller-lifecycle row to the timeline.
 *
 * Called AFTER the Telegram send and the latch update, and swallowing its own
 * errors, because the alert is the load-bearing part: a Firestore hiccup here
 * must not un-latch the alert and re-send it every minute, nor bubble out and
 * abort the loop before the remaining projects are checked.
 *
 * `description` goes in sensorName, which is this schema's "what this event is
 * about" field — the same way arm/disarm rows carry a profile name and boot
 * rows carry a reset reason.
 */
async function recordLifecycleEvent(
  projectId: string,
  eventType: EventType,
  description: string,
  nowMs: number
): Promise<void> {
  const alarmEvent: Omit<AlarmEvent, "id"> = {
    sensorId: "",
    rfId: "",
    sensorName: description,
    eventType,
    batteryLow: false,
    rssi: 0,
    timestamp: Timestamp.fromMillis(nowMs),
  };
  try {
    await db.collection(`projects/${projectId}/events`).add(alarmEvent);
  } catch (err) {
    console.warn(
      `deviceLiveness: could not record ${eventType} for project=${projectId}`,
      err
    );
  }
}
