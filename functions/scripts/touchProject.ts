#!/usr/bin/env npx tsx
//
// Force a device-config rebuild.
//
// RTDB /{projectId}/config is DERIVED state: buildRtdbConfig only runs from
// onProfileChange / onRuleChange / onRemoteChange / onProjectConfigChange.
// None of those fire on a SENSOR write, so the familyId migration left the
// config holding stale full-width rfIds — which the new firmware cannot
// match. This writes the project doc back to itself to trigger a rebuild.
//
// Touches a RULE, not the project doc: onProjectConfigChange deliberately
// early-returns unless sirenEnabled or sirenBaseAddress changed, so writing
// the project back to itself is a no-op by design. onRuleChange has no such
// guard and always rebuilds.
//
// Read-modify-write of a single field to its OWN current value: no data
// changes, only the write event the listener needs.

import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

const keyPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
if (!keyPath) {
  console.error("Set GOOGLE_APPLICATION_CREDENTIALS to the service-account json.");
  process.exit(2);
}
// eslint-disable-next-line @typescript-eslint/no-var-requires
const serviceAccount = require(keyPath);
if (getApps().length === 0) {
  initializeApp({ credential: cert(serviceAccount) });
}

async function main() {
  const db = getFirestore();
  const projects = await db.collection("projects").get();
  for (const p of projects.docs) {
    const profiles = await db.collection(`projects/${p.id}/profiles`).get();
    for (const prof of profiles.docs) {
      const rules = await db
        .collection(`projects/${p.id}/profiles/${prof.id}/rules`)
        .limit(1)
        .get();
      if (rules.empty) continue;
      const rule = rules.docs[0];
      // Writing `name` back unchanged emits onDocumentWritten with no data
      // change, which is exactly what rebuildConfig needs.
      await rule.ref.update({ name: rule.data().name });
      console.log(
        `touched rule ${rule.id} in profile ${prof.id} of ${p.id} — rebuild triggered`
      );
      break;
    }
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
