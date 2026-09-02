// Cloud Function: onProfileChange
// Trigger: Firestore writes to profile docs and rule docs under active profiles.
// Rebuilds RTDB /config from the isActiveOnDevice profile.

import { onDocumentWritten } from "firebase-functions/v2/firestore";
import { db, rtdb } from "./admin";
import { Rule, Sensor, Remote } from "./types";
import { buildRtdbConfig } from "./buildConfig";

// Trigger on profile document changes
export const onProfileChange = onDocumentWritten(
  { document: "projects/{projectId}/profiles/{profileId}", region: "europe-west1" },
  async (event) => {
    const projectId = event.params.projectId;
    await rebuildConfig(projectId);
  }
);

// Trigger on rule changes within any profile
export const onRuleChange = onDocumentWritten(
  { document: "projects/{projectId}/profiles/{profileId}/rules/{ruleId}", region: "europe-west1" },
  async (event) => {
    const projectId = event.params.projectId;
    await rebuildConfig(projectId);
  }
);

// Trigger on project-level changes that affect the device config (e.g. sirenEnabled)
export const onProjectConfigChange = onDocumentWritten(
  { document: "projects/{projectId}", region: "europe-west1" },
  async (event) => {
    const before = event.data?.before.data();
    const after = event.data?.after.data();
    if (!before || !after) return;
    // Only rebuild when sirenEnabled changes — other project fields don't affect RTDB config.
    if (before.sirenEnabled === after.sirenEnabled) return;
    const projectId = event.params.projectId;
    await rebuildConfig(projectId);
  }
);

async function rebuildConfig(projectId: string): Promise<void> {
  // Find the active-on-device profile
  const profileSnap = await db
    .collection(`projects/${projectId}/profiles`)
    .where("isActiveOnDevice", "==", true)
    .limit(1)
    .get();

  // No early return on an empty active profile: a project with no armed
  // profile can still have always-rules, which must reach the device.
  const activeProfile = profileSnap.empty ? null : profileSnap.docs[0];

  let rules: Rule[] = [];
  if (activeProfile) {
    const rulesSnap = await db
      .collection(`projects/${projectId}/profiles/${activeProfile.id}/rules`)
      .get();
    rules = rulesSnap.docs.map((d) => ({ id: d.id, ...d.data() } as Rule));
  }

  // Always-rules are collected from EVERY profile — see buildConfig. A
  // collection-group query would also span other projects, so this walks the
  // project's own profiles instead.
  const allProfilesSnap = await db
    .collection(`projects/${projectId}/profiles`)
    .get();
  const alwaysRules: Rule[] = [];
  for (const prof of allProfilesSnap.docs) {
    const rs = await db
      .collection(`projects/${projectId}/profiles/${prof.id}/rules`)
      .where("always", "==", true)
      .get();
    for (const d of rs.docs) {
      alwaysRules.push({ id: d.id, ...d.data() } as Rule);
    }
  }

  // Remotes are independent of profiles and rules: they control the alarm
  // rather than trigger it, so they are loaded before the early return
  // below and carried into every config shape.
  const remotesSnap = await db.collection(`projects/${projectId}/remotes`).get();
  const remotes: Remote[] = remotesSnap.docs.map(
    (d) => ({ id: d.id, ...d.data() } as Remote)
  );
  const remoteIds = remotes
    .map((remote) => parseInt(remote.identity, 16))
    .filter((id) => Number.isFinite(id));

  if (!activeProfile && alwaysRules.length === 0) {
    // Nothing to evaluate — write the thin config shape with r/c omitted.
    // RTDB drops empty arrays on .set(), so writing r: [], c: [] here would
    // round-trip as if the fields were never set at all; the firmware's
    // parseConfigJson (cloud_client.cpp) is written to treat missing r/c as
    // "zero sensors" (not a parse failure) specifically to make this work.
    // m is still carried here: pairing a remote to a project that has no
    // active profile and no always-rules must still reach the device, or
    // the remote would silently never work.
    await rtdb.ref(`${projectId}/config`).set({
      a: false,
      d: 120,
      e: true,
      ...(remoteIds.length > 0 ? { m: remoteIds } : {}),
    });
    return;
  }

  // Get all sensors
  const sensorsSnap = await db.collection(`projects/${projectId}/sensors`).get();
  const sensors: Sensor[] = sensorsSnap.docs.map((d) => ({ id: d.id, ...d.data() } as Sensor));

  // Get current armed state from RTDB
  const armedSnap = await rtdb.ref(`${projectId}/state/armed`).get();
  const armed = armedSnap.val() === true;

  // Get project for sirenDurationSec and sirenEnabled
  const projectDoc = await db.doc(`projects/${projectId}`).get();
  const sirenDurationSec = projectDoc.exists
    ? (projectDoc.data()?.sirenDurationSec ?? 120)
    : 120;
  const sirenEnabled = projectDoc.exists
    ? (projectDoc.data()?.sirenEnabled !== false)
    : true;

  const config = buildRtdbConfig(
    rules,
    sensors,
    armed,
    sirenDurationSec,
    sirenEnabled,
    alwaysRules,
    remotes
  );
  await rtdb.ref(`${projectId}/config`).set(config);
}
