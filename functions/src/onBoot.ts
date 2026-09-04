// Cloud Function: onBoot
// Trigger: RTDB onValueWritten on /{projectId}/state/boot
//
// Writes a timeline row every time the controller restarts, naming the reset
// reason (power_on / twdt / panic / brownout / ...).
//
// WHY THIS EXISTS: a device that crashes and reboots looks EXACTLY like one
// that never left — it reconnects, resumes heartbeating, and the UI goes
// green again. Before this, state/boot was surfaced only as a transient
// banner on the Operations page, so a restart nobody happened to be looking
// at left no record at all. Diagnosing the 2026-09-04 outage meant
// reconstructing the device's death from raw RTDB nodes and heartbeat
// arithmetic; the timeline should simply say it.
//
// A TRIGGER, not a polling job: Cloud Scheduler allows only 3 free jobs per
// BILLING ACCOUNT and scheduleTick + deadSensorCheck already use two (see
// CLAUDE.md). Triggers do not count against that limit — same reasoning as
// onHeartbeat.

import { onValueWritten } from "firebase-functions/v2/database";
import { Timestamp } from "firebase-admin/firestore";
import { db } from "./admin";
import { AlarmEvent } from "./types";
import { bootEventTimeMs, bootReasonLabel, RtdbBootRecord } from "./bootEvent";

export const onBoot = onValueWritten(
  { ref: "/{projectId}/state/boot", region: "europe-west1" },
  async (event) => {
    const projectId = event.params.projectId;

    // Deletions (e.g. an admin clearing state) are not a boot.
    if (!event.data.after.exists()) return;

    const after = event.data.after.val() as RtdbBootRecord | null;
    if (!after) return;

    // The device rewrites state/boot once per boot, but a no-op write (same
    // reason AND same timestamp) would otherwise file a duplicate row. `at`
    // changes every real boot, so comparing both is enough.
    const before = event.data.before.val() as RtdbBootRecord | null;
    if (
      before &&
      before.reason === after.reason &&
      before.at === after.at
    ) {
      return;
    }

    try {
      const alarmEvent: Omit<AlarmEvent, "id"> = {
        sensorId: "",
        rfId: "",
        // Raw reason, not translated — the UI maps it via bootReasonKey().
        // Matches how arm/disarm rows carry a profile name here.
        sensorName: bootReasonLabel(after.reason),
        eventType: "device_restart",
        batteryLow: false,
        rssi: 0,
        // Server time when the device's own clock cannot be trusted: on a
        // fast boot state/boot is written before NTP syncs, and an epoch-
        // adjacent value would file this row in 1970 where it sorts below
        // every real event. See bootEvent.ts.
        timestamp: Timestamp.fromMillis(
          bootEventTimeMs(after.at, Date.now())
        ),
      };
      await db.collection(`projects/${projectId}/events`).add(alarmEvent);
    } catch (err) {
      // A boot row is diagnostic, not load-bearing. Never retry-storm against
      // a deleted project — same posture as onHeartbeat.
      console.warn(`onBoot: could not record boot for project=${projectId}`, err);
    }
  }
);
