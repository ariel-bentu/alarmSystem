// Task: scheduleTick — fire due schedule edges.
//
// Runs every minute, dispatched from doSchedule.ts's single scheduler job
// (see the table there). NOT an onSchedule() of its own: Cloud Scheduler
// allows only 3 free jobs per BILLING ACCOUNT, so every periodic task in
// this project is a plain async function invoked by the one dispatcher.
//
// Fires due schedule edges by writing exactly the fields a human pressing a
// button in Operations writes — the scheduler gets no private path to the
// device, so every downstream trigger (config rebuild, timeline, Telegram)
// is reused unmodified.
//
// Cost: an idle minute is two collection-group queries matching zero
// documents, which is what the precomputed nextArmAt/nextDisarmAt fields
// exist to buy. Do not replace them with a full scan.

import { Timestamp } from "firebase-admin/firestore";
import { db, rtdb } from "./admin";
import { Schedule, Profile } from "./types";
import { decideEdge, EdgeKind } from "./scheduleDecision";
import { nextArmInstant, nextDisarmInstant } from "./nextOccurrence";
import { planAdvance } from "./scheduleAdvance";

export async function scheduleTick(): Promise<void> {
  {
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

        await advance(
          projectId,
          doc.ref,
          schedule,
          edge,
          decision === "fire",
          now
        );
      }
    }
  }
}

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
    // Stamped BEFORE commands/armed so onArmStateChange, which triggers on
    // that write, attributes the timeline row to the schedule rather than
    // defaulting to the app.
    await rtdb.ref(`${projectId}/commands/armed_via`).set("schedule");
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

/**
 * Recompute this schedule's next fire time after an edge is handled.
 *
 * ONLY the edge that just fired is advanced. Advancing both was a real bug:
 * a schedule of arm 16:23 / disarm 16:26 armed correctly, then rewrote
 * nextDisarmAt to the NEXT DAY, so the 16:26 disarm never became due and the
 * house stayed armed for 24 hours with no warning logged anywhere.
 *
 * The cause is that nextDisarmInstant() anchors to `armAt`. Once the arm has
 * fired, `armAt` is tomorrow's arm, so the disarm derived from it is
 * tomorrow's too — discarding the disarm still owed by the cycle that just
 * started. Advancing one edge at a time keeps the pending edge of an
 * in-flight cycle intact.
 */
async function advance(
  projectId: string,
  ref: FirebaseFirestore.DocumentReference,
  schedule: Schedule,
  edge: EdgeKind,
  fired: boolean,
  now: Date
): Promise<void> {
  const projectSnap = await db.doc(`projects/${projectId}`).get();
  const tz = (projectSnap.data()?.timezone as string) || "UTC";

  // Recompute both, but only WRITE the one that was handled — see
  // planAdvance() for why that asymmetry is load-bearing.
  const armAt = nextArmInstant(schedule, tz, now);
  const disarmAt = nextDisarmInstant(schedule, tz, armAt, now);

  const storedOther =
    edge === "arm" ? schedule.nextDisarmAt : schedule.nextArmAt;

  const plan = planAdvance({
    edge,
    nextArmAt: armAt,
    nextDisarmAt: disarmAt,
    storedOtherEdgeMs: storedOther ? storedOther.toMillis() : null,
    nowMs: now.getTime(),
  });

  const update: Record<string, unknown> = {};
  if (plan.writeArm) {
    update.nextArmAt = armAt ? Timestamp.fromDate(armAt) : null;
  }
  if (plan.writeDisarm) {
    update.nextDisarmAt = disarmAt ? Timestamp.fromDate(disarmAt) : null;
  }
  if (fired) update.lastFiredAt = Timestamp.fromDate(now);
  if (plan.disable) update.enabled = false;

  await ref.update(update);
}
