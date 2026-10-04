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
import { Project, Sensor } from "./types";
import { familyIdOf } from "./keruiEvent";
import { sensorFamilyId } from "./sensorFamily";
import { parseCause, isCauseFresh } from "./alarmCause";
import { judgeFor, JudgeContext, Verdict } from "./snapshotJudge";
import { loadJudgeKeys, type JudgeKeys } from "./judgeConfig";
import { sendTelegramPhoto } from "./telegram";

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

  if (project.nvrMode !== "capture+judge") {
    console.log(
      `onSnapshotUploaded: nvrMode=${project.nvrMode ?? "off"} for ${projectId} — skipping judge`
    );
    return;
  }

  const causeSnap = await deps.rtdb.ref(`${projectId}/state/alarm_cause`).get();
  const cause = parseCause(causeSnap.val());
  const causeFamily = cause?.rfId ? familyIdOf(cause.rfId) : null;
  const armedAtTrigger =
    cause !== null &&
    causeFamily !== null &&
    causeFamily === family &&
    // Freshness is judged relative to the TRIGGER's own ts, not wall-clock
    // now — see the module doc comment for why this is what makes the gate
    // race-safe against a later disarm.
    isCauseFresh(cause, ts);

  if (!armedAtTrigger) {
    console.log(
      `onSnapshotUploaded: no fresh matching alarm_cause for rfId=${rfId} ts=${ts} — skipping judge`
    );
    return;
  }

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

  if (verdict === "breach") {
    await timelineRef.update({
      aiNote: `confirmed breach (AI): ${reason}`,
    });
    if (!project.telegramBotToken || !project.telegramChatId) {
      console.log(
        `onSnapshotUploaded: breach verdict for ${rfId}/${ts} but no Telegram configured`
      );
      return;
    }
    const caption =
      `⚠ Confirmed breach — ${sensorName}, ` +
      `${cameraName ?? `camera ${channel}`} — ${reason}`;
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

  await deps.rtdb.ref(`${projectId}/commands/fp`).set({ rfId, ts, at: deps.now() });
  await timelineRef.update({
    aiNote: `false positive (AI): ${reason}`,
  });
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
    };

    await handleSnapshotUpload(deps, objectName);
  }
);
