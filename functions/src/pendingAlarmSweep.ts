// Fail-loud backstop for judge-gated alerting.
//
// onAlarm defers a non-definite sensor's notification and lets the AI
// verdict announce it (see judgeDefer.ts). If no verdict ever arrives — NVR
// unreachable, snapshot upload failed, judge errored, Storage trigger lost —
// the alarm would otherwise be announced by nobody at all. This sweep
// announces it late rather than never.
//
// Dispatched from doSchedule's every-minute row, NOT its own onSchedule():
// Cloud Scheduler allows only 3 free jobs per BILLING ACCOUNT.
//
// The ~60s worst-case lateness is a deliberate, accepted trade (the
// alternative was holding a Cloud Function open for the wait). The SIREN is
// unaffected on this path: the device sounds it locally from its own rules.

import { db } from "./admin";
import { Project } from "./types";
import { formatAlarm } from "./telegram";
import { notify } from "./notify";
import { alarmSeverity } from "./breachCertainty";
import { isPendingAlarmStale, type PendingAlarm } from "./pendingAlarm";

/**
 * Announce every deferred alarm that has waited past its deadline.
 *
 * Isolated per project and per marker: one failed notification must not cost
 * the others theirs, matching checkDeviceLiveness and deadSensorCheck.
 */
export async function sweepPendingAlarms(nowMs: number): Promise<void> {
  const projectsSnap = await db.collection("projects").get();

  for (const projectDoc of projectsSnap.docs) {
    const project = { id: projectDoc.id, ...projectDoc.data() } as Project;

    try {
      const pendingSnap = await db
        .collection(`projects/${project.id}/pendingAlarms`)
        .get();

      for (const markerDoc of pendingSnap.docs) {
        const marker = markerDoc.data() as PendingAlarm;
        if (!isPendingAlarmStale(marker, nowMs)) continue;

        // Deleted BEFORE notifying, so a notification that throws cannot
        // leave the marker behind to fire again every minute. notify() never
        // throws, but the ordering holds regardless of that guarantee.
        await markerDoc.ref.delete();

        const label = marker.label ?? null;
        // The tier onAlarm would have sent. No verdict arrived, so the
        // sensor's own certainty is all there is to go on — and for a
        // non-definite sensor that means P0, which a muted phone silences.
        // This is the documented cost of marking a sensor non-definite:
        // NVR health is load-bearing for night alerting.
        const severity = alarmSeverity(marker.definite === true);

        console.log(
          `sweepPendingAlarms: no judge verdict for ${project.id}/${markerDoc.id} — ` +
            `sending ${severity} fallback`
        );

        await notify(project.id, project, {
          text: label ? formatAlarm(label) : "🚨 Alarm triggered!",
          severity,
          // Named so the owner can tell this apart from a judged alarm: the
          // cameras did NOT clear this, nobody looked at all.
          title: marker.definite === true ? "Alarm" : "Alarm (unverified)",
          link: true,
        });
      }
    } catch (err) {
      console.error(
        `sweepPendingAlarms: failed for project=${project.id}`,
        err
      );
    }
  }
}
