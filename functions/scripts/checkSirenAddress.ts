#!/usr/bin/env npx tsx
//
// Pre-flash safety check. The EEPROM magic bump discards the device's stored
// Config, which is where the siren base address lives — and that address is
// write-only device->cloud, so if Firestore does not have it, flashing loses
// the physical siren pairing for good.
//
// Prints what the cloud knows, per project. Read-only.

import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { getDatabase } from "firebase-admin/database";

const keyPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
if (!keyPath) {
  console.error("Set GOOGLE_APPLICATION_CREDENTIALS to the service-account json.");
  process.exit(2);
}
// eslint-disable-next-line @typescript-eslint/no-var-requires
const serviceAccount = require(keyPath);

if (getApps().length === 0) {
  initializeApp({
    credential: cert(serviceAccount),
    databaseURL: `https://${serviceAccount.project_id}-default-rtdb.europe-west1.firebasedatabase.app`,
  });
}

async function main() {
  const db = getFirestore();
  const rtdb = getDatabase();
  const projects = await db.collection("projects").get();

  for (const p of projects.docs) {
    const data = p.data();
    console.log(`\n=== project ${p.id} (${data.name ?? ""}) ===`);
    console.log(`  Firestore sirenBaseAddress: ${data.sirenBaseAddress ?? "*** ABSENT ***"}`);

    const cfg = await rtdb.ref(`${p.id}/config`).get();
    const val = cfg.val() as { s?: number; r?: string[] } | null;
    console.log(
      `  RTDB config.s (pushed to device): ${
        val?.s === undefined ? "*** ABSENT ***" : "0x" + val.s.toString(16).toUpperCase()
      }`
    );
    console.log(`  RTDB config.r (armed sensors): ${JSON.stringify(val?.r ?? [])}`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
