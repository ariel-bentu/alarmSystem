// Cloud Function: onAlarm
// Trigger: RTDB onValueWritten on /{projectId}/state/siren_active
// When value becomes true → notify, naming the cause.
//
// This is the alarm notifier for every alarm that sounds the siren, whether
// the server evaluated it (onSensorEvent) or the device did. Both writers
// record /{projectId}/state/alarm_cause first; see alarmCause.ts for the two
// shapes and why the device's differs.
//
// Because it is the single chokepoint for both writers, this is also where
// per-sensor breach certainty is applied: a DEFINITE sensor notifies at
// severity "alarm" (Pushover priority 2, repeats until acknowledged) and a
// NON-DEFINITE one at "loud" (priority 1, audible through a muted ringer but
// single-shot), which onSnapshotUploaded escalates to "alarm" if the AI judge
// confirms a breach. See breachCertainty.ts.

import { onValueWritten } from "firebase-functions/v2/database";
import { Timestamp } from "firebase-admin/firestore";
import { db, rtdb } from "./admin";
import { AlarmEvent, Project, Rule, Sensor } from "./types";
import { formatAlarm } from "./telegram";
import { notify } from "./notify";
import {
  isCauseFresh,
  parseCause,
  resolveCauseLabel,
  type AlarmCause,
} from "./alarmCause";
import { reusableVerdict } from "./judgeGate";
import { priorVerdictsFromDocs } from "./verdictHistory";
import { sensorFamilyId } from "./sensorFamily";
import { alarmSeverity, resolveCauseCertainty } from "./breachCertainty";
import { shouldDeferToJudge } from "./judgeDefer";
import { pendingAlarmId, PENDING_FALLBACK_SEC } from "./pendingAlarm";

export const onAlarm = onValueWritten(
  { ref: "/{projectId}/state/siren_active", region: "europe-west1" },
  async (event) => {
    const after = event.data.after.val();
    const before = event.data.before.val();

    // Only act when value transitions to true
    if (after !== true || before === true) return;

    const projectId = event.params.projectId;

    // Resolved BEFORE the notify gate below: the timeline row must be
    // written whether or not this project has a channel configured. The alarm
    // that actually sounded the siren is the single most important thing the
    // event list can show, and it was previously missing from it entirely —
    // only sensor triggers and arm/disarm were ever mirrored.
    const { label, definite, sensor, causeRfId, cause } = await resolveCause(projectId);

    try {
      const alarmEvent: Omit<AlarmEvent, "id"> = {
        sensorId: "",
        rfId: "",
        // The cause if we could name one ("Front door", "SOS (remote)"),
        // otherwise blank — which the UI renders as the muted "System".
        sensorName: label ?? "",
        eventType: "alarm",
        batteryLow: false,
        rssi: 0,
        timestamp: Timestamp.now(),
      };
      await db.collection(`projects/${projectId}/events`).add(alarmEvent);
    } catch (err) {
      // Never let a timeline write cost the actual alarm notification.
      console.warn(`onAlarm: could not record event for project=${projectId}`, err);
    }

    const projectDoc = await db.doc(`projects/${projectId}`).get();
    if (!projectDoc.exists) return;
    const project = { id: projectDoc.id, ...projectDoc.data() } as Project;

    // --- Verdict REUSE: this alarm's own trigger may have no images ---
    //
    // The capture cooldown is enforced on the DEVICE, so a trigger inside it
    // produces no snapshot at all and onSnapshotUploaded never runs for it.
    // That is the normal shape of a count_in_window alarm: trigger 1 captures
    // and is judged, trigger 2 completes the count and has nothing.
    //
    // So the alarming trigger inherits the episode's existing verdict rather
    // than waiting for one that cannot arrive. Reuse is FORCED, not chosen —
    // the window is exactly the period during which fresh evidence is
    // unobtainable (judgeGate.reusableVerdict).
    const reused = await reuseVerdictFor(projectId, project, cause, sensor);
    if (reused?.verdict === "safe") {
      // Already judged safe, and the rules fired anyway. Silence the siren and
      // say so quietly, instead of waking anyone and then explaining.
      console.log(
        `onAlarm: ${projectId} alarm on ${causeRfId} inherits a SAFE verdict ` +
          `(${reused.reason}) — suppressing`
      );
      await rtdb
        .ref(`${projectId}/commands/fp`)
        .set({ rfId: reused.rfId, ts: reused.ts, at: Date.now() });
      await notify(projectId, project, {
        text: `✓ Cleared — ${label ?? "alarm"} — ${reused.reason}`,
        severity: "notice",
      });
      return;
    }
    if (reused?.verdict === "breach") {
      // Already judged breach: this is a confirmed intrusion, so skip the
      // deferral entirely and go straight out at emergency.
      console.log(
        `onAlarm: ${projectId} alarm on ${causeRfId} inherits a BREACH verdict ` +
          `(${reused.reason}) — notifying at emergency`
      );
      await notify(projectId, project, {
        text: label ? formatAlarm(label) : "🚨 Alarm triggered!",
        severity: "alarm",
        title: "Breach confirmed",
        link: true,
      });
      return;
    }

    // Judge-gated alerting: for a non-definite sensor whose cameras can
    // actually produce a verdict, say nothing NOW and let the verdict decide
    // the tier. Without this the owner is woken and then reassured — on
    // 2026-10-05 the P0 went out at 05:53:05 and "both channels empty"
    // landed at 05:53:06.
    //
    // The siren is NOT affected here: the device fires it locally and the
    // existing /commands/fp advisory is what cuts it short.
    if (shouldDeferToJudge(project, sensor)) {
      const pendingId = pendingAlarmId(causeRfId);
      if (pendingId) {
        // Written BEFORE returning, and the only exit that skips notify():
        // if this write throws, the catch below falls through to notifying
        // immediately rather than leaving the alarm unannounced.
        try {
          await db.doc(`projects/${projectId}/pendingAlarms/${pendingId}`).set({
            at: Date.now(),
            rfId: pendingId,
            label: label ?? null,
            definite,
          });
          console.log(
            `onAlarm: deferring notification for ${projectId}/${pendingId} ` +
              `pending judge verdict (fallback in ${PENDING_FALLBACK_SEC}s)`
          );
          return;
        } catch (err) {
          // Fail loud: an unwritable marker means nothing can announce this
          // alarm later, so announce it now.
          console.warn(
            `onAlarm: could not defer ${projectId}/${pendingId} — notifying immediately`,
            err
          );
        }
      }
    }

    await notify(projectId, project, {
      text: label ? formatAlarm(label) : "🚨 Alarm triggered!",
      // A definite sensor sends priority 2, which repeats until acknowledged.
      // A non-definite one sends priority 1 — audible through a muted ringer
      // but single-shot — which the AI judge escalates to priority 2 if it
      // confirms a breach. The message text is identical either way: that
      // channel has no tiering, and divergent wording would make the two
      // channels disagree about one event.
      severity: alarmSeverity(definite),
      title: definite ? "Alarm" : "Alarm (unconfirmed)",
      link: true, // tapping opens the PWA on the events page
    });
  }
);

/**
 * The verdict this alarm should inherit, or null.
 *
 * Looks up the sensor's recent coordination docs and picks the newest one
 * inside the reuse window. Returns the rfId/ts it came from as well, because a
 * `safe` result is acted on by writing /commands/fp — which the device matches
 * against the trigger that is actually sounding the siren, so it must carry
 * the identity of the judged trigger, not of the alarm.
 *
 * Returns null on anything unresolvable: no sensor, no cameras, judge not
 * enabled, nothing recent enough. Fail-loud — the caller then behaves exactly
 * as it did before this path existed.
 */
async function reuseVerdictFor(
  projectId: string,
  project: Project,
  cause: AlarmCause | null,
  sensor: Sensor | null
): Promise<{ verdict: "safe" | "breach"; reason: string; rfId: string; ts: number } | null> {
  if (!sensor || project.nvrMode !== "capture+judge") return null;
  if ((sensor.cameras?.length ?? 0) === 0) return null;

  // The alarm's own moment. The cause's `at` is written synchronously just
  // before siren_active flips, so it is the closest thing to the trigger ts
  // available here.
  const alarmAt = typeof cause?.at === "number" ? cause.at : Date.now();

  // Only this sensor's docs: ids are `{rfId}_{ts}`, so a prefix range on the
  // document name avoids reading every judging doc in the project.
  //
  // endAt appends \uf8ff (a high private-use code point) rather than repeating
  // the prefix. Firestore range bounds are lexicographic, so
  // startAt(p)+endAt(p) would match only the exact string `p` and return
  // nothing at all. This is the standard prefix-query idiom.
  const snap = await db
    .collection(`projects/${projectId}/snapshotJudging`)
    .orderBy("__name__")
    .startAt(`${sensor.rfId}_`)
    .endAt(`${sensor.rfId}_`)
    .get();

  const priors = priorVerdictsFromDocs(
    snap.docs.map((d) => ({ id: d.id, ...(d.data() as { channels?: never }) }))
  );
  const best = reusableVerdict(
    priors,
    alarmAt,
    project.captureCooldownSec ?? DEFAULT_CAPTURE_COOLDOWN_SEC,
    JUDGE_LATENCY_GRACE_SEC
  );
  if (!best) return null;
  return {
    verdict: best.verdict,
    reason: best.reason,
    rfId: sensor.rfId,
    ts: best.ts,
  };
}

/** Matches the firmware's own default when `cc` is absent from the config. */
const DEFAULT_CAPTURE_COOLDOWN_SEC = 45;
/**
 * Grace added to the reuse window for judge latency: a trigger just past the
 * cooldown does get its own images, but the verdict takes a few seconds to
 * land. Measured ~4-7s end to end on hardware 2026-10-05.
 */
const JUDGE_LATENCY_GRACE_SEC = 8;

/**
 * Read the recorded cause and resolve BOTH what to call it and how loudly to
 * notify.
 *
 * One function because the two need the same two lookups (every sensor, and
 * the rules of the device-active profile), and doing them twice would double
 * the Firestore reads on the alarm path.
 *
 * `label` is null when the cause names nothing — the caller then sends its
 * generic message. `definite` defaults to TRUE on every unknown, so a cause
 * we cannot resolve still wakes the owner.
 *
 * NOTE: this deliberately does NOT short-circuit on a server-written label
 * the way its predecessor did. The server now writes `rfId` alongside
 * `label`, and returning early on the label would skip the lookups that the
 * certainty decision needs. resolveCauseLabel still prefers the label, so
 * the displayed text is unchanged.
 */
async function resolveCause(projectId: string): Promise<{
  label: string | null;
  definite: boolean;
  // The sensor that fired, when the cause identifies one. Needed by
  // shouldDeferToJudge, which reads its `cameras` to decide whether a verdict
  // is even possible. Null on every unknown, which blocks deferral.
  sensor: Sensor | null;
  // The cause's raw identity, for keying the pending-alarm marker. May be a
  // 20-bit family (device-written) or a full 24-bit rfId (server-written);
  // pendingAlarmId() normalises both.
  causeRfId: string | null;
  // The parsed cause itself, for verdict reuse — which needs its `at` as the
  // alarm's moment. Null when there is no usable cause.
  cause: AlarmCause | null;
}> {
  const causeSnap = await rtdb.ref(`${projectId}/state/alarm_cause`).get();
  const cause = parseCause(causeSnap.val());
  if (!cause || !isCauseFresh(cause, Date.now())) {
    // No usable cause: generic message, and fail loud.
    return { label: null, definite: true, sensor: null, causeRfId: null, cause: null };
  }

  // Map the reported code → sensor, then find a rule covering that sensor.
  //
  // Indexed under BOTH the full rfId and the 20-bit family, because the
  // device's TriggerCause carries whatever identity its config used: a
  // pre-family firmware sends the full 24-bit rfId, the new one sends the
  // family. Keying on only one of them would leave every device-side alarm
  // unnamed for the other — during the rollout, and permanently if a device
  // is ever rolled back. Both keys point at the same sensor, so a cause is
  // resolvable either way.
  const sensorsSnap = await db.collection(`projects/${projectId}/sensors`).get();
  const sensorNamesByRfId: Record<string, string> = {};
  const sensorIdsByRfId: Record<string, string> = {};
  // Keyed by DOC ID, not rfId: a rule names its members by id, so this is
  // what the certainty lookup walks when a multi-sensor rule covers the cause.
  //
  // Holds the WHOLE sensor, not just its certainty: the deferral decision also
  // reads `cameras`, and the docs are already in hand here — narrowing the map
  // would mean a second read of the same collection on the alarm path.
  const sensorsById: Record<string, Sensor> = {};
  for (const doc of sensorsSnap.docs) {
    const sensor = { id: doc.id, ...doc.data() } as Sensor;
    sensorsById[sensor.id] = sensor;
    for (const key of [sensor.rfId, sensorFamilyId(sensor)]) {
      if (!key) continue;
      sensorNamesByRfId[key] = sensor.name;
      sensorIdsByRfId[key] = sensor.id;
    }
  }

  // Rules come from the profile the DEVICE is running, which is the one that
  // evaluated this alarm — not the server's active profile.
  let rules: Rule[] = [];
  const profileSnap = await db
    .collection(`projects/${projectId}/profiles`)
    .where("isActiveOnDevice", "==", true)
    .limit(1)
    .get();
  if (!profileSnap.empty) {
    const rulesSnap = await db
      .collection(`projects/${projectId}/profiles/${profileSnap.docs[0].id}/rules`)
      .get();
    rules = rulesSnap.docs.map((d) => ({ id: d.id, ...d.data() } as Rule));
  }

  // Resolved by the SAME rfId→id indirection resolveCauseCertainty uses, so
  // the sensor whose cameras gate the deferral is the one whose flag set the
  // tier. Null when the cause names no known sensor, which blocks deferral.
  const causeRfId = cause.rfId?.trim() ?? null;
  const causeSensorId = causeRfId ? sensorIdsByRfId[causeRfId] : undefined;

  return {
    label: resolveCauseLabel(cause, rules, sensorNamesByRfId, sensorIdsByRfId),
    // The SENSOR's own flag, not the covering rule's — see
    // resolveCauseCertainty for why a rule lookup was removed. `rules` above
    // is still needed, but only by resolveCauseLabel.
    definite: resolveCauseCertainty(cause, sensorsById, sensorIdsByRfId),
    sensor: causeSensorId ? (sensorsById[causeSensorId] ?? null) : null,
    causeRfId,
    cause,
  };
}
