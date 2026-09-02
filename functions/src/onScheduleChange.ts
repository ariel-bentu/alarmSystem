// Cloud Function: onScheduleChange
// Trigger: Firestore writes to projects/{projectId}/schedules/{scheduleId}.
// Recomputes the derived nextArmAt / nextDisarmAt fields.
//
// This is the SINGLE writer of those fields on edit, which is what makes
// scheduleTick's cheap indexed query trustworthy. If they go stale, a
// schedule silently stops firing.

import { onDocumentWritten } from "firebase-functions/v2/firestore";
import { Timestamp } from "firebase-admin/firestore";
import { db } from "./admin";
import { Schedule } from "./types";
import { nextArmInstant, nextDisarmInstant } from "./nextOccurrence";
import { keepStoredEdge } from "./schedulePending";

export const onScheduleChange = onDocumentWritten(
  {
    document: "projects/{projectId}/schedules/{scheduleId}",
    region: "europe-west1",
  },
  async (event) => {
    const after = event.data?.after;
    if (!after?.exists) return; // deleted — nothing to recompute

    const projectId = event.params.projectId;
    const schedule = { id: after.id, ...after.data() } as Schedule;

    // A disabled schedule has no next fire time. Clearing rather than
    // recomputing means re-enabling recomputes from NOW, so a schedule
    // paused for three weeks does not wake believing it owes a past fire.
    let armAt: Date | null = null;
    let disarmAt: Date | null = null;

    if (schedule.enabled) {
      const projectSnap = await db.doc(`projects/${projectId}`).get();
      const tz = (projectSnap.data()?.timezone as string) || "UTC";
      const now = new Date();
      armAt = nextArmInstant(schedule, tz, now);
      disarmAt = nextDisarmInstant(schedule, tz, armAt, now);
    }

    let nextArmAt = armAt ? Timestamp.fromDate(armAt) : null;
    let nextDisarmAt = disarmAt ? Timestamp.fromDate(disarmAt) : null;

    // NEVER clobber an edge that is due but has not fired yet.
    //
    // This function triggers on ANY write to the document — including
    // scheduleTick's own `lastFiredAt` write when an edge fires. Without the
    // guard below, firing the arm caused this function to overwrite the
    // still-pending disarm with the NEXT day's. See schedulePending.ts for
    // the full production incident.
    //
    // A genuine EDIT must still win, even when it moves an edge later, so
    // the guard only applies when the wall-clock definition is unchanged.
    const before = event.data?.before;
    const prev = before?.exists ? (before.data() as Schedule) : null;
    const defChanged = (edge: "arm" | "disarm"): boolean => {
      if (!prev) return true; // newly created — nothing to preserve
      const timeChanged =
        edge === "arm"
          ? prev.armTime !== schedule.armTime
          : prev.disarmTime !== schedule.disarmTime;
      return (
        timeChanged ||
        prev.enabled !== schedule.enabled ||
        prev.date !== schedule.date ||
        JSON.stringify(prev.days ?? []) !== JSON.stringify(schedule.days ?? [])
      );
    };

    const nowMs = Date.now();
    if (
      keepStoredEdge({
        storedMs: schedule.nextArmAt?.toMillis() ?? null,
        computedMs: nextArmAt?.toMillis() ?? null,
        definitionChanged: defChanged("arm"),
        nowMs,
      })
    ) {
      nextArmAt = schedule.nextArmAt ?? null;
    }
    if (
      keepStoredEdge({
        storedMs: schedule.nextDisarmAt?.toMillis() ?? null,
        computedMs: nextDisarmAt?.toMillis() ?? null,
        definitionChanged: defChanged("disarm"),
        nowMs,
      })
    ) {
      nextDisarmAt = schedule.nextDisarmAt ?? null;
    }

    // Recursion guard: this function writes the very fields it triggers on,
    // so bail when they already hold the computed values.
    const currentArm = schedule.nextArmAt?.toMillis() ?? null;
    const currentDisarm = schedule.nextDisarmAt?.toMillis() ?? null;
    if (
      currentArm === (nextArmAt?.toMillis() ?? null) &&
      currentDisarm === (nextDisarmAt?.toMillis() ?? null)
    ) {
      return;
    }

    await after.ref.update({ nextArmAt, nextDisarmAt });
  }
);
