// Cloud Function: onProfileChange
// Trigger: Firestore writes to profile docs and rule docs under active profiles.
// Rebuilds RTDB /config from the isActiveOnDevice profile.

import { onDocumentWritten } from "firebase-functions/v2/firestore";
import { db, rtdb } from "./admin";
import { Rule, Sensor } from "./types";
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

async function rebuildConfig(projectId: string): Promise<void> {
  // Find the active-on-device profile
  const profileSnap = await db
    .collection(`projects/${projectId}/profiles`)
    .where("isActiveOnDevice", "==", true)
    .limit(1)
    .get();

  if (profileSnap.empty) {
    // No active profile — write the thin config shape with r/c omitted.
    // RTDB drops empty arrays on .set(), so writing r: [], c: [] here would
    // round-trip as if the fields were never set at all; the firmware's
    // parseConfigJson (cloud_client.cpp) is written to treat missing r/c as
    // "zero sensors" (not a parse failure) specifically to make this work.
    await rtdb.ref(`${projectId}/config`).set({
      a: false,
      d: 120,
    });
    return;
  }

  const profileDoc = profileSnap.docs[0];

  // Get rules for this profile
  const rulesSnap = await db
    .collection(`projects/${projectId}/profiles/${profileDoc.id}/rules`)
    .get();
  const rules: Rule[] = rulesSnap.docs.map((d) => ({ id: d.id, ...d.data() } as Rule));

  // Get all sensors
  const sensorsSnap = await db.collection(`projects/${projectId}/sensors`).get();
  const sensors: Sensor[] = sensorsSnap.docs.map((d) => ({ id: d.id, ...d.data() } as Sensor));

  // Get current armed state from RTDB
  const armedSnap = await rtdb.ref(`${projectId}/state/armed`).get();
  const armed = armedSnap.val() === true;

  // Get project for sirenDurationSec
  const projectDoc = await db.doc(`projects/${projectId}`).get();
  const sirenDurationSec = projectDoc.exists
    ? (projectDoc.data()?.sirenDurationSec ?? 120)
    : 120;

  const config = buildRtdbConfig(rules, sensors, armed, sirenDurationSec);
  await rtdb.ref(`${projectId}/config`).set(config);
}
