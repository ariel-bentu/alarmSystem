// Cloud Function: scheduleTick
// Trigger: every minute.
//
// Fires due schedule edges by writing exactly the fields a human pressing a
// button in Operations writes — the scheduler gets no private path to the
// device, so every downstream trigger (config rebuild, timeline, Telegram)
// is reused unmodified.
//
// Cost: an idle minute is two collection-group queries matching zero
// documents, which is what the precomputed nextArmAt/nextDisarmAt fields
// exist to buy. Do not replace them with a full scan.
//
// This is the 2nd of Cloud Scheduler's 3 free jobs per BILLING ACCOUNT
// (deadSensorCheck is the other).

import { onSchedule } from "firebase-functions/v2/scheduler";
import { Timestamp } from "firebase-admin/firestore";
import { db, rtdb } from "./admin";
import { Schedule, Profile } from "./types";
import { decideEdge, EdgeKind } from "./scheduleDecision";
import { nextArmInstant, nextDisarmInstant } from "./nextOccurrence";

export const scheduleTick = onSchedule(
  { schedule: "every 1 minutes", region: "europe-west1" },
  async (_event) => {
    const now = new Date();
    const nowTs = Timestamp.fromDate(now);

    for (const edge of ["arm", "disarm"] as EdgeKind[]) {
      const field = edge === "arm" ? "nextArmAt" : "nextDisarmAt";
      const dueSnap = await db
        .collectionGroup("schedules")
        .where("enabled", "==", true)
        .where(field, "<=", nowTs)
        .get();

      for (const doc of dueSnap.docs) {
        const schedule = { id: doc.id, ...doc.data() } as Schedule;
        // .../projects/{projectId}/schedules/{id} — parent of the collection.
        const projectId = doc.ref.parent.parent?.id;
        if (!projectId) continue;

        const dueTs = edge === "arm" ? schedule.nextArmAt : schedule.nextDisarmAt;
        if (!dueTs) continue;

        const profileSnap = await db
          .doc(`projects/${projectId}/profiles/${schedule.profileId}`)
          .get();
        const profileEnabled =
          profileSnap.exists && (profileSnap.data() as Profile).enabled !== false;

        const decision = decideEdge(dueTs.toDate(), now, profileEnabled, edge);

        if (decision === "not_due") continue;
        if (decision !== "fire") {
          console.warn(
            `schedule ${projectId}/${schedule.id} ${edge}: ${decision}`
          );
        } else {
          await fireEdge(projectId, schedule, edge);
        }

        await advance(projectId, doc.ref, schedule, decision === "fire", now);
      }
    }
  }
);

/**
 * Apply an edge. Writes the same fields OperationsPage.armSide writes:
 * device -> profile.isActiveOnDevice + RTDB commands/armed;
 * server -> profile.isActiveOnServer + project.serverArmed.
 */
async function fireEdge(
  projectId: string,
  schedule: Schedule,
  edge: EdgeKind
): Promise<void> {
  const arming = edge === "arm";
  const field =
    schedule.side === "device" ? "isActiveOnDevice" : "isActiveOnServer";

  // Exactly one profile may be active per side, so clear the others.
  const profilesSnap = await db
    .collection(`projects/${projectId}/profiles`)
    .get();
  const batch = db.batch();
  for (const p of profilesSnap.docs) {
    const shouldBeActive = arming && p.id === schedule.profileId;
    if (Boolean(p.data()[field]) !== shouldBeActive) {
      batch.update(p.ref, { [field]: shouldBeActive });
    }
  }
  await batch.commit();

  if (schedule.side === "device") {
    await rtdb.ref(`${projectId}/commands/armed`).set(arming);
    // Disarming must always silence. commands/armed only reaches the device
    // on a VALUE CHANGE, so disarming an already-disarmed device delivers
    // nothing and a sounding siren would run to its timer.
    if (!arming) {
      await rtdb.ref(`${projectId}/commands/siren`).set(false);
    }
  } else {
    await db.doc(`projects/${projectId}`).update({ serverArmed: arming });
  }
}

/** Recompute this schedule's next fire times after an edge is handled. */
async function advance(
  projectId: string,
  ref: FirebaseFirestore.DocumentReference,
  schedule: Schedule,
  fired: boolean,
  now: Date
): Promise<void> {
  const projectSnap = await db.doc(`projects/${projectId}`).get();
  const tz = (projectSnap.data()?.timezone as string) || "UTC";

  const armAt = nextArmInstant(schedule, tz, now);
  const disarmAt = nextDisarmInstant(schedule, tz, armAt, now);

  const update: Record<string, unknown> = {
    nextArmAt: armAt ? Timestamp.fromDate(armAt) : null,
    nextDisarmAt: disarmAt ? Timestamp.fromDate(disarmAt) : null,
  };
  if (fired) update.lastFiredAt = Timestamp.fromDate(now);

  // A one-time schedule with nothing left ahead disables itself, so it stops
  // matching the tick's query instead of lingering as a dead row.
  if (!armAt && !disarmAt) update.enabled = false;

  await ref.update(update);
}
