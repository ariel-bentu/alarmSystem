// Cloud Function: onProfileChange
// Trigger: Firestore writes to profile docs and rule docs under active profiles.
// Rebuilds RTDB /config from the isActiveOnDevice profile.

import { onDocumentWritten } from "firebase-functions/v2/firestore";
import { db, rtdb } from "./admin";
import { Rule, Sensor, Remote } from "./types";
import { buildRtdbConfig, sirenKey } from "./buildConfig";

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

// Trigger on remote control changes — adding or removing a remote must reach the device
export const onRemoteChange = onDocumentWritten(
  { document: "projects/{projectId}/remotes/{remoteId}", region: "europe-west1" },
  async (event) => {
    const projectId = event.params.projectId;
    await rebuildConfig(projectId);
  }
);

// Trigger on project-level changes that affect the device config
// (sirenEnabled, sirenBaseAddress)
export const onProjectConfigChange = onDocumentWritten(
  { document: "projects/{projectId}", region: "europe-west1" },
  async (event) => {
    const before = event.data?.before.data();
    const after = event.data?.after.data();
    if (!before || !after) return;
    // Only rebuild when a config-affecting field changes — other project
    // fields don't affect RTDB config.
    //
    // sirenBaseAddress MUST be in this list: onSirenAddress writes it to
    // Firestore, and this trigger is the only thing that carries it into
    // RTDB config and therefore down to the device. Omit it and the address
    // is stored durably but never delivered — the pairing-recovery path
    // would look correct and do nothing.
    if (
      before.sirenEnabled === after.sirenEnabled &&
      before.sirenBaseAddress === after.sirenBaseAddress
    ) {
      return;
    }
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

  // Read the project doc once, up here: the siren address is needed by BOTH
  // the thin early-return shape below and the full build further down.
  const projectDoc = await db.doc(`projects/${projectId}`).get();
  const projectData = projectDoc.exists ? projectDoc.data() : undefined;
  const sirenBaseAddress = projectData?.sirenBaseAddress as string | undefined;

  if (!activeProfile && alwaysRules.length === 0) {
    // Nothing to evaluate — write the thin config shape with r/c omitted.
    // RTDB drops empty arrays on .set(), so writing r: [], c: [] here would
    // round-trip as if the fields were never set at all; the firmware's
    // parseConfigJson (cloud_client.cpp) is written to treat missing r/c as
    // "zero sensors" (not a parse failure) specifically to make this work.
    // m is still carried here: pairing a remote to a project that has no
    // active profile and no always-rules must still reach the device, or
    // the remote would silently never work. s is carried for exactly the
    // same reason — a device with a wiped EEPROM must be able to recover its
    // siren address regardless of whether any profile is active.
    await rtdb.ref(`${projectId}/config`).set({
      a: false,
      d: 120,
      e: true,
      ...(remoteIds.length > 0 ? { m: remoteIds } : {}),
      ...sirenKey(sirenBaseAddress),
    });
    return;
  }

  // Get all sensors
  const sensorsSnap = await db.collection(`projects/${projectId}/sensors`).get();
  const sensors: Sensor[] = sensorsSnap.docs.map((d) => ({ id: d.id, ...d.data() } as Sensor));

  // Get current armed state from RTDB
  const armedSnap = await rtdb.ref(`${projectId}/state/armed`).get();
  const armed = armedSnap.val() === true;

  // Project-level siren settings. projectData was read above, since the
  // thin-config path needs the siren address too.
  const sirenDurationSec = projectData?.sirenDurationSec ?? 120;
  const sirenEnabled = projectData?.sirenEnabled !== false;

  const config = buildRtdbConfig(
    rules,
    sensors,
    armed,
    sirenDurationSec,
    sirenEnabled,
    alwaysRules,
    remotes,
    sirenBaseAddress
  );
  await rtdb.ref(`${projectId}/config`).set(config);
}
