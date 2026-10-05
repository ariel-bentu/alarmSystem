// Cloud Function: onSnapshotUploaded
// Trigger: Storage onObjectFinalized on {projectId}/snapshots/{rfId}/{ts}/ch{N}.jpg
//
// Central orchestrator for the camera-snapshot feature. On every captured
// image (armed or not — capture happens on every in-sight trigger per the
// design spec) it augments the Firestore timeline with the image, and ONLY
// when the project is in "capture+judge" mode AND this specific trigger
// alarmed, runs the vision judge and reacts to its verdict.
//
// ARM-STATE-AT-TRIGGER-TIME (the hard part — see task-13 report for the full
// writeup):
//
// There is no per-event "armed" field anywhere in the data model — neither
// the device's RTDB /events/{rfId}/{ts} write nor the Firestore mirror
// (onSensorEvent.ts) stamps one. What DOES exist, already relied on by
// onAlarm.ts for exactly this kind of correlation, is
// /{projectId}/state/alarm_cause: both the device (handleSensorEvent) and
// the server (onSensorEvent.ts) write it SYNCHRONOUSLY, before anything else
// for that trigger, the moment an alarm actually fires — and only then. A
// device-written cause carries the triggering rfId; a server-written one
// carries only a label (rule/sensor name), no rfId.
//
// This handler uses "an alarm was recorded for this exact {rfId, ts}" as the
// armed signal: read alarm_cause, and treat the trigger as armed iff the
// cause's rfId resolves to the SAME FAMILY as the snapshot's rfId (matching
// by family, not exact code, for the same reason every other matcher in
// this codebase does — see sensorFamilyId) AND the cause is still "fresh"
// relative to the snapshot's OWN ts (not wall-clock now — see below).
//
// Why this is race-safe against a later disarm: freshness is judged against
// the snapshot's `ts` (the trigger's own timestamp), not against
// Date.now() at the time this function happens to run. A disarm that occurs
// after the trigger cannot retroactively erase the fact that the cause was
// written; it also cannot forge a fresh-looking cause for an rfId that
// never alarmed. The only way this signal is WRONG is a prior, unrelated
// alarm leaving a cause for the same sensor within the freshness window,
// which would be a false "armed" — but CAUSE_MAX_AGE_MS is 60s and capture
// cooldown/debounce makes two independent triggers for the same family
// within 60s unlikely, and judging an extra trigger is non-harmful (the
// judge can only ever produce an advisory that SILENCES an alarm that did
// in fact happen — see the next paragraph).
//
// Accepted failure direction: if this signal is ever wrong, the only
// consequence is (a) judging a trigger that did not actually alarm — wasted
// API call, breach alert would misfire a Telegram but never suppress
// anything since there's no alarm to suppress — or (b) NOT judging a
// trigger that did alarm — the siren simply runs its course, same as if
// the judge were off entirely. Neither direction can forge a false-positive
// advisory for a sensor that never had a matching alarm_cause, because the
// advisory write below additionally requires the SAME match. This is the
// "prefer NOT writing the advisory" safe direction the brief calls for.
//
// MULTI-CHANNEL COORDINATION (a sensor names SEVERAL channels in
// `Sensor.cameras`; each is captured and uploaded as a SEPARATE Storage
// object, so each fires its own invocation of this function):
//
// Implemented the brief's "defensible simpler v1": each channel is judged
// INDEPENDENTLY as its object finalizes. A small coordination doc
// projects/{projectId}/snapshotJudging/{rfId}_{ts} records, per channel,
// which verdict it got. On a "breach" verdict: send the Telegram photo
// immediately UNLESS a breach was already recorded for this {rfId, ts} (so
// three channels all judged breach send exactly one Telegram, not three).
// On a "safe" verdict: write the false-positive advisory ONLY IF no breach
// has been recorded for this {rfId, ts} in the coordination doc so far.
//
// Failure modes of this simpler v1, called out explicitly:
//  - It does NOT wait for every channel before advising "safe" the way the
//    design spec's ideal ("all channels safe") does. If channel 1 judges
//    safe and writes the advisory BEFORE channel 2 (a later invocation)
//    judges breach, the advisory already went out — a window where a breach
//    on one angle can be preceded by a premature safe advisory from
//    another. This is the one place this implementation is weaker than the
//    spec's ideal.
//  - Mitigated, not eliminated: (a) breach and safe for sibling channels of
//    the same trigger usually finalize and get judged within a second or
//    two of each other (small JPEGs, same cooldown-gated trigger), so the
//    window is narrow; (b) the coordination doc is still updated with the
//    breach even after a safe advisory went out, and the Telegram breach
//    alert is NOT suppressed by a prior safe — "first breach wins" for
//    ALERTING always fires, it is only the ADVISORY ordering that can race.
//    So a real intruder caught on a second camera still gets a Telegram
//    even if a first, blind angle already (wrongly) advised false-positive.
//  - This is the documented, accepted trade-off. It was originally justified
//    by the expected channel count being unknowable cloud-side: capture was
//    "all LIVE channels on the NVR" whenever a sensor named none, and that
//    liveness is NVR state this function cannot cheaply see.
//
//    THAT JUSTIFICATION NO LONGER HOLDS. Per-sensor multi-camera selection
//    made `Sensor.cameras` an explicit list, so the expected count for a
//    {rfId, ts} is just that array's length — already loaded here to resolve
//    the sensor name. A "wait for all channels, then advise" version is now
//    straightforwardly implementable: hold the advisory until the
//    coordination doc has a verdict for every configured channel. Left
//    UNIMPLEMENTED deliberately — it is a behaviour change to the judge path,
//    which has never been exercised on real hardware (see CLAUDE.md), so it
//    wants its own task and its own field test rather than riding along with
//    a config-shape change. The race window and its mitigations above are
//    unchanged in the meantime.

import { onObjectFinalized } from "firebase-functions/v2/storage";
import { Timestamp, type Firestore } from "firebase-admin/firestore";
import type { Database } from "firebase-admin/database";
import { parseSnapshotPath } from "./snapshotPath";
import { Project, Rule, Sensor } from "./types";
import { causeFamilyOf, familyIdOf } from "./keruiEvent";
import { sensorFamilyId } from "./sensorFamily";
import { parseCause, isCauseFresh } from "./alarmCause";
import { judgeFor, JudgeContext, Verdict } from "./snapshotJudge";
import { loadJudgeKeys, type JudgeKeys } from "./judgeConfig";
import { sendTelegramPhoto } from "./telegram";
import { notify } from "./notify";
import { breachVerdictSeverity, isDefiniteBreach } from "./breachCertainty";
import { shouldJudge, breachSatisfiesAny } from "./judgeGate";

/**
 * Everything the core handler needs, injected so it is unit-testable
 * without a live Firebase project. The real onObjectFinalized wrapper below
 * builds this from ./admin + Storage + config/judge.
 */
export interface SnapshotUploadDeps {
  db: Pick<Firestore, "doc" | "collection">;
  rtdb: Pick<Database, "ref">;
  downloadJpeg(projectId: string, objectName: string): Promise<Buffer>;
  downloadUrl(projectId: string, objectName: string): Promise<string>;
  /**
   * Resolved lazily: only called once a snapshot has actually passed the
   * capture+judge and armed gates, so a project that never judges never reads
   * the secrets doc.
   */
  judgeKeys(): Promise<JudgeKeys>;
  now(): number;
  /**
   * Injected like the rest: this module's tests drive handleSnapshotUpload
   * directly, and notify() reaches Firestore for the Pushover credentials.
   */
  notify: typeof notify;
}

interface ChannelVerdict {
  verdict: Verdict;
  reason: string;
  at: number;
}

interface JudgingDoc {
  channels?: Record<string, ChannelVerdict>;
}

/**
 * The orchestration core. Exported for tests; the deployed function wraps
 * this with real admin/Storage dependencies.
 */
export async function handleSnapshotUpload(
  deps: SnapshotUploadDeps,
  objectName: string
): Promise<void> {
  const parsed = parseSnapshotPath(objectName);
  if (!parsed) {
    console.log(`onSnapshotUploaded: ignoring non-snapshot object ${objectName}`);
    return;
  }
  const { projectId, rfId, ts, channel } = parsed;

  const projectRef = deps.db.doc(`projects/${projectId}`);
  const projectSnap = await projectRef.get();
  if (!projectSnap.exists) {
    console.log(`onSnapshotUploaded: project ${projectId} does not exist`);
    return;
  }
  const project = { id: projectSnap.id, ...projectSnap.data() } as Project;

  // Resolve the sensor by FAMILY (same pattern as onSensorEvent.ts /
  // onAlarm.ts) — a snapshot's rfId is the full code the device/NVR path
  // keyed the object on, but sensors are matched by their 20-bit family.
  const sensorsSnap = await deps.db.collection(`projects/${projectId}/sensors`).get();
  const family = familyIdOf(rfId);
  let sensor: Sensor | null = null;
  for (const doc of sensorsSnap.docs) {
    const candidate = { id: doc.id, ...doc.data() } as Sensor;
    if (family !== null && sensorFamilyId(candidate) === family) {
      sensor = candidate;
      break;
    }
  }
  const sensorName = sensor?.name ?? (rfId === "MANUAL" ? "Manual capture" : rfId);

  // --- 1. Always augment the timeline, regardless of mode/armed state ---
  const url = await deps.downloadUrl(projectId, objectName);
  const timelineId = `${rfId}_${ts}`;
  const timelineRef = deps.db.doc(`projects/${projectId}/timeline/${timelineId}`);
  await timelineRef.set(
    {
      rfId,
      sensorId: sensor?.id ?? null,
      sensorName,
      timestamp: Timestamp.fromMillis(ts),
      // One entry per {rfId, ts}; each channel's own invocation appends
      // itself here rather than overwriting, so 1-3 channels for the same
      // trigger land on the SAME doc. `merge: true` on the whole write
      // would still clobber the snapshots ARRAY (arrays are replaced, not
      // merged, by Firestore's merge semantics) — so the array itself is
      // updated via arrayUnion in a separate call below, after this set()
      // establishes the doc's base fields idempotently.
    },
    { merge: true }
  );
  const { FieldValue } = await import("firebase-admin/firestore");
  await timelineRef.update({
    snapshots: FieldValue.arrayUnion({ channel, url }),
  });

  // --- 2. Judge gate ---
  // Manual captures have no alarm to confirm or deny — skip the judge entirely.
  if (rfId === "MANUAL") {
    console.log(`onSnapshotUploaded: manual capture for ${projectId} — skipping judge`);
    return;
  }

  // --- 2a. The ARMED gate (was: "did this trigger alarm?") ---
  //
  // Judge every armed trigger. The old gate required a fresh matching
  // alarm_cause, which made the judge structurally unreachable for
  // count_in_window rules — see judgeGate.shouldJudge() and the spec. An
  // unalarmed trigger's verdict is now load-bearing: a later trigger in the
  // same episode inherits it.
  const armedSnap = await deps.rtdb.ref(`${projectId}/state/armed`).get();
  const armed = armedSnap.val() === true;
  if (!shouldJudge({ armed, nvrMode: project.nvrMode })) {
    console.log(
      `onSnapshotUploaded: armed=${armed} nvrMode=${project.nvrMode ?? "off"} ` +
        `for ${projectId} — skipping judge`
    );
    return;
  }

  // Did THIS trigger already alarm? No longer a gate on judging — only on what
  // to do with the verdict. A matching fresh cause means the rules fired, so a
  // safe verdict should write the false-positive advisory; its absence means
  // the rules have not fired (yet), so a breach verdict may need to raise the
  // alarm itself via commands/breach.
  //
  // causeFamilyOf, NOT familyIdOf: the cause carries the already-shifted
  // 20-bit family when the DEVICE wrote it and the full 24-bit rfId when the
  // server did. familyIdOf shifted the device's value a second time
  // ("0x009BF" -> "0x0009B"), which is why this never matched a device-written
  // cause and the judge never ran on real hardware before 2026-10-04.
  const causeSnap = await deps.rtdb.ref(`${projectId}/state/alarm_cause`).get();
  const cause = parseCause(causeSnap.val());
  const causeFamily = cause?.rfId ? causeFamilyOf(cause.rfId) : null;
  const alreadyAlarmed =
    cause !== null &&
    causeFamily !== null &&
    causeFamily === family &&
    // Freshness against the TRIGGER's own ts, not wall-clock now — see the
    // module doc comment for why that is what makes this race-safe against a
    // later disarm.
    isCauseFresh(cause, ts);

  // Keys live in the server-only `config/judge` doc (see judgeConfig.ts).
  // Read only here, past every gate above.
  const keys = await deps.judgeKeys();
  const providerKey =
    project.judgeProvider === "claude"
      ? keys.anthropic
      : project.judgeProvider === "gemini"
        ? keys.gemini
        : undefined;
  if (!providerKey) {
    console.log(
      `onSnapshotUploaded: no API key configured for judgeProvider=` +
        `${project.judgeProvider ?? "unset"} — skipping judge`
    );
    return;
  }

  // --- 3. Run the judge ---
  const jpeg = await deps.downloadJpeg(projectId, objectName);
  const judge = judgeFor(project.judgeProvider, keys, project.judgeModel);
  const hour = new Date(ts).getHours();
  const timeOfDay = hour >= 6 && hour < 18 ? "day" : "night";
  // The channel's human name, when the project has given it one. Absent for
  // an unnamed channel, and the judge/caption both fall back to "camera N" —
  // so a project that never names its cameras reads exactly as it did before.
  const cameraName = project.cameraNames?.[String(channel)]?.trim() || undefined;
  const ctx: JudgeContext = {
    sensorName,
    channel,
    ...(cameraName ? { cameraName } : {}),
    armed: true,
    timeOfDay,
    prompt: project.judgePrompt ?? "",
  };
  const { verdict, reason } = await judge.judge(jpeg, ctx);

  // --- 4. Coordination doc (all-channels v1 — see module doc comment) ---
  const judgingRef = deps.db.doc(`projects/${projectId}/snapshotJudging/${rfId}_${ts}`);
  const judgingSnap = await judgingRef.get();
  const judgingDoc = (judgingSnap.exists ? judgingSnap.data() : {}) as JudgingDoc;
  const priorChannels = judgingDoc.channels ?? {};
  const alreadyHasBreach = Object.values(priorChannels).some((c) => c.verdict === "breach");

  await judgingRef.set(
    {
      channels: {
        ...priorChannels,
        [String(channel)]: { verdict, reason, at: deps.now() },
      },
    },
    { merge: true }
  );

  // This verdict is about to announce the alarm (breach escalation, silent
  // all-clear, or a sibling's breach having announced it already), so release
  // any deferral onAlarm set up. Cleared on EVERY path below — a surviving
  // marker would have doSchedule's sweeper announce the same alarm twice.
  //
  // Keyed by family, the only identity onAlarm and this handler share: see
  // pendingAlarm.ts. Best-effort — a failure here must never cost the verdict
  // itself, and the worst case is one duplicate fallback notification.
  const clearPending = async () => {
    if (family === null) return;
    try {
      await deps.db.doc(`projects/${projectId}/pendingAlarms/${family}`).delete();
    } catch (err) {
      console.warn(
        `onSnapshotUploaded: could not clear pendingAlarms/${family} for ${projectId}`,
        err
      );
    }
  };

  if (verdict === "breach") {
    await clearPending();

    // --- Judge-as-evidence: RAISE the alarm when the rules have not ---
    //
    // The rules did not fire for this trigger (no fresh matching cause), but a
    // condition covering this sensor opted into vision evidence. A person
    // visibly in frame is STRONGER evidence than two unjudged triggers — a cat
    // pacing a yard satisfies 2-in-30s — so the count/AND is the fallback, not
    // the gold standard. See the spec and judgeGate.breachSatisfiesAny().
    //
    // commands/breach, not a cloud write to state/siren_active: the siren
    // decision stays on the DEVICE, where every other siren decision lives,
    // and serverActions.triggerSiren can remain off. Strictly ADDITIVE, the
    // mirror of commands/fp's strictly-subtractive rule.
    let raisedByJudge = false;
    if (!alreadyAlarmed && sensor) {
      const rules = await loadDeviceActiveRules(deps, projectId);
      if (breachSatisfiesAny(rules, sensor.id)) {
        await deps.rtdb
          .ref(`${projectId}/commands/breach`)
          .set({ rfId, ts, at: deps.now() });
        raisedByJudge = true;
        console.log(
          `onSnapshotUploaded: breach on ${rfId}/${ts} with no rule alarm — ` +
            `raising via commands/breach (breach_satisfies)`
        );
      }
    }

    await timelineRef.update({
      aiNote: `confirmed breach (AI): ${reason}`,
    });
    const caption =
      `⚠ Confirmed breach — ${sensorName}, ` +
      `${cameraName ?? `camera ${channel}`} — ${reason}`;

    // Routed through notify so a Pushover-only project is woken by a
    // confirmed breach. The PHOTO below stays Telegram-only: Pushover
    // attachments are out of scope, so a Telegram-enabled project receives
    // both this text and the captioned photo. Accepted — a 3am breach is
    // exactly when redundancy is wanted.
    //
    // A DEFINITE sensor's alarm already went out as priority 2 and is still
    // repeating; a second emergency would be two repeating alerts for one
    // event. A NON-DEFINITE sensor's alarm went out as priority 1, so this
    // verdict is the escalation and the first emergency push.
    //
    // A JUDGE-RAISED alarm is a third case: nothing has been sent at all for
    // this episode, because the rules never fired. So it is always the first
    // and only alert, and always emergency — the downgrade above exists purely
    // to avoid doubling an alert that already went out.
    //
    // This is also why a judge-raised alarm skips judgeWaitSec and
    // sirenHoldSec: both exist to WAIT for a verdict, and the verdict is what
    // raised this alarm. There is nothing left to wait for, and holding would
    // only delay a confirmed breach.
    await deps.notify(projectId, project, {
      text: caption,
      severity: raisedByJudge
        ? "alarm"
        : breachVerdictSeverity(isDefiniteBreach(sensor)),
      title: raisedByJudge ? "Breach detected" : "Confirmed breach",
      link: true, // the snapshots this breach was judged on are on that page
    });

    if (!project.telegramBotToken || !project.telegramChatId) {
      console.log(
        `onSnapshotUploaded: breach verdict for ${rfId}/${ts} but no Telegram configured`
      );
      return;
    }
    await sendTelegramPhoto(project.telegramBotToken, project.telegramChatId, jpeg, caption);
    return;
  }

  // verdict === "safe": the SAFE direction is to NOT write the advisory on
  // any doubt. If a breach was already recorded for this trigger (by a
  // sibling channel, in either order of arrival), leaving the alarm
  // standing is strictly safer than retroactively suppressing it — do not
  // write the advisory.
  if (alreadyHasBreach) {
    console.log(
      `onSnapshotUploaded: safe verdict for ${rfId}/${ts} ch${channel}, but a sibling ` +
        `channel already judged breach — NOT writing the false-positive advisory`
    );
    // The sibling's breach invocation already announced this alarm, so the
    // deferral is spent even though THIS channel adds nothing.
    await clearPending();
    await timelineRef.update({
      // Prefix "safe (AI" is load-bearing: web/src/features/explore/
      // snapshotThumb.ts parses the verdict back out of this free text by
      // prefix, so the camera NAME may be appended but the opening must not
      // change.
      aiNote:
        `safe (AI, ${cameraName ?? `channel ${channel}`}): ${reason}` +
        ` — advisory withheld, another channel saw a breach`,
    });
    return;
  }

  await clearPending();
  await deps.rtdb.ref(`${projectId}/commands/fp`).set({ rfId, ts, at: deps.now() });
  await timelineRef.update({
    aiNote: `false positive (AI): ${reason}`,
  });

  // A quiet all-clear, so a glance at the phone explains the earlier alert.
  // severity "notice" is Pushover priority -1: delivered silently, never
  // waking anyone. Sent regardless of the sensor's certainty — a cleared
  // trigger is worth explaining either way.
  //
  // Written AFTER the advisory and the timeline note, both of which matter
  // more: notify never throws, but ordering keeps the advisory first on
  // principle.
  //
  // Deliberately NOT on the alreadyHasBreach path above, which returns
  // early: that branch withholds the advisory precisely because a sibling
  // channel saw a breach, and an "all clear" would contradict a standing
  // alarm.
  await deps.notify(projectId, project, {
    text: `✓ Cleared — ${sensorName}, ${cameraName ?? `camera ${channel}`} — ${reason}`,
    severity: "notice",
  });
}

/**
 * Rules of the profile the DEVICE is running — the same lookup onAlarm's
 * resolveCause does, and for the same reason: that is the profile which
 * evaluated (or failed to evaluate) this trigger, not the server's active one.
 *
 * Read lazily, only on a breach verdict that might need to raise an alarm, so
 * the common paths (safe verdicts, already-alarmed breaches) pay nothing.
 */
async function loadDeviceActiveRules(
  deps: Pick<SnapshotUploadDeps, "db">,
  projectId: string
): Promise<Rule[]> {
  const profileSnap = await deps.db
    .collection(`projects/${projectId}/profiles`)
    .where("isActiveOnDevice", "==", true)
    .limit(1)
    .get();
  if (profileSnap.empty) return [];
  const rulesSnap = await deps.db
    .collection(`projects/${projectId}/profiles/${profileSnap.docs[0].id}/rules`)
    .get();
  return rulesSnap.docs.map((d) => ({ id: d.id, ...d.data() }) as Rule);
}

// Bucket pinned explicitly rather than left to firebase-functions' default-
// bucket resolution (which reads FIREBASE_CONFIG at deploy/emulate time) —
// matching the one real bucket this project uses (see web/.env.local's
// VITE_FIREBASE_STORAGE_BUCKET, and the firmware's uploadSnapshot(), Task
// 7/13 ledger). This also sidesteps firebase-functions throwing at MODULE
// LOAD when FIREBASE_CONFIG is absent, which would otherwise make this file
// unimportable under vitest.
const SNAPSHOT_BUCKET = "alarm-system-100.firebasestorage.app";

// MUST match the bucket's region: a Storage-triggered function can only listen
// to a bucket in its own region (a europe-west1 function cannot trigger on a
// us-east1 bucket). The bucket is in us-east1 (kept in the US to stay on the
// free tier), so THIS function alone runs in us-east1 — every other function
// stays europe-west1. If the bucket is ever moved, change this too.
const SNAPSHOT_BUCKET_REGION = "us-east1";

export const onSnapshotUploaded = onObjectFinalized(
  { region: SNAPSHOT_BUCKET_REGION, bucket: SNAPSHOT_BUCKET },
  async (event) => {
    const objectName = event.data.name;
    const bucketName = event.data.bucket;

    const { db, rtdb } = await import("./admin");
    const { getStorage } = await import("firebase-admin/storage");

    const deps: SnapshotUploadDeps = {
      db,
      rtdb,
      async downloadJpeg(_projectId, name) {
        const [buf] = await getStorage().bucket(bucketName).file(name).download();
        return buf;
      },
      async downloadUrl(_projectId, name) {
        const { getDownloadURL } = await import("firebase-admin/storage");
        const file = getStorage().bucket(bucketName).file(name);
        return getDownloadURL(file);
      },
      judgeKeys: () => loadJudgeKeys(db),
      now: () => Date.now(),
      notify,
    };

    await handleSnapshotUpload(deps, objectName);
  }
);
