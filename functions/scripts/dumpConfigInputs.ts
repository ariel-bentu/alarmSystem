#!/usr/bin/env npx tsx
//
// Dump exactly what buildRtdbConfig reads, so a stale RTDB config can be
// diagnosed from data rather than guessed at.

import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

const keyPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
if (!keyPath) {
  console.error("Set GOOGLE_APPLICATION_CREDENTIALS.");
  process.exit(2);
}
// eslint-disable-next-line @typescript-eslint/no-var-requires
const serviceAccount = require(keyPath);
if (getApps().length === 0) {
  initializeApp({ credential: cert(serviceAccount) });
}

async function main() {
  const db = getFirestore();
  for (const p of (await db.collection("projects").get()).docs) {
    console.log(`\n=== ${p.id} ===`);
    const sensors = await db.collection(`projects/${p.id}/sensors`).get();
    const byId = new Map(sensors.docs.map((d) => [d.id, d.data()]));

    for (const prof of (await db.collection(`projects/${p.id}/profiles`).get()).docs) {
      const pd = prof.data();
      console.log(
        `  profile ${prof.id} (${pd.displayName}) activeOnDevice=${pd.isActiveOnDevice} enabled=${pd.enabled}`
      );
      const rules = await db
        .collection(`projects/${p.id}/profiles/${prof.id}/rules`)
        .get();
      for (const r of rules.docs) {
        const rd = r.data();
        const names = (rd.sensors ?? []).map((sid: string) => {
          const s = byId.get(sid);
          return s ? `${s.rfId}->${s.familyId ?? "NO-FAMILY"}` : `MISSING(${sid})`;
        });
        console.log(
          `    rule ${r.id} "${rd.name}" always=${rd.always === true} type=${rd.condition?.type} sensors=[${names.join(", ")}]`
        );
      }
    }
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
