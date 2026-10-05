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
import { isCauseFresh, parseCause, resolveCauseLabel } from "./alarmCause";
import { sensorFamilyId } from "./sensorFamily";
import { alarmSeverity, resolveCauseCertainty } from "./breachCertainty";

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
    const { label, definite } = await resolveCause(projectId);

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
async function resolveCause(
  projectId: string
): Promise<{ label: string | null; definite: boolean }> {
  const causeSnap = await rtdb.ref(`${projectId}/state/alarm_cause`).get();
  const cause = parseCause(causeSnap.val());
  if (!cause || !isCauseFresh(cause, Date.now())) {
    // No usable cause: generic message, and fail loud.
    return { label: null, definite: true };
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
  const sensorsById: Record<string, Pick<Sensor, "definiteBreach">> = {};
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

  return {
    label: resolveCauseLabel(cause, rules, sensorNamesByRfId, sensorIdsByRfId),
    // The SENSOR's own flag, not the covering rule's — see
    // resolveCauseCertainty for why a rule lookup was removed. `rules` above
    // is still needed, but only by resolveCauseLabel.
    definite: resolveCauseCertainty(cause, sensorsById, sensorIdsByRfId),
  };
}
