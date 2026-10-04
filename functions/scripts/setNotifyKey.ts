#!/usr/bin/env npx tsx
//
// Writes a project's Pushover credentials into the server-only
// projects/{projectId}/secrets/notify document.
//
// That subcollection is locked to `allow read, write: if false` in
// firestore.rules — no client can read it, only Cloud Functions through the
// admin SDK. This script uses a service-account credential, which bypasses
// rules the same way.
//
// Usage:
//   GOOGLE_APPLICATION_CREDENTIALS=path/to/sa.json \
//     npm run set:notifyKey -- <projectId> <appToken> <userKey>
//   GOOGLE_APPLICATION_CREDENTIALS=... npm run set:notifyKey -- --show <projectId>
//
// Credentials are never echoed back, only masked. Get the app token by
// creating an application at https://pushover.net/apps/build; the user key is
// on the Pushover dashboard.

import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { notifySecretsPath } from "../src/notifySecrets";

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

function mask(k: string): string {
  return k.length <= 8 ? "****" : `${k.slice(0, 4)}…${k.slice(-4)} (${k.length} chars)`;
}

async function main() {
  const db = getFirestore();
  const args = process.argv.slice(2);

  if (args[0] === "--show") {
    const projectId = args[1];
    if (!projectId) {
      console.error("Usage: npm run set:notifyKey -- --show <projectId>");
      process.exit(2);
    }
    const snap = await db.doc(notifySecretsPath(projectId)).get();
    if (!snap.exists) {
      console.log(
        `${notifySecretsPath(projectId)} does not exist — Pushover not configured.`
      );
      return;
    }
    const data = snap.data() ?? {};
    for (const field of ["pushoverToken", "pushoverUserKey"]) {
      const v = data[field];
      console.log(
        `${field.padEnd(18)} ${typeof v === "string" && v ? mask(v) : "(not set)"}`
      );
    }
    return;
  }

  const [projectId, appToken, userKey] = args;
  if (!projectId || !appToken || !userKey) {
    console.error("Usage: npm run set:notifyKey -- <projectId> <appToken> <userKey>");
    process.exit(2);
  }

  // Pushover tokens and user keys are both 30 chars. Catch a swapped or
  // truncated paste before it becomes a silent 400 at alarm time.
  for (const [label, value] of [
    ["appToken", appToken],
    ["userKey", userKey],
  ] as const) {
    if (value.length !== 30) {
      console.warn(
        `warning: ${label} is ${value.length} chars; Pushover credentials are normally 30.`
      );
    }
  }

  const projectRef = db.doc(`projects/${projectId}`);
  if (!(await projectRef.get()).exists) {
    console.error(`No such project: projects/${projectId}`);
    process.exit(2);
  }

  await db
    .doc(notifySecretsPath(projectId))
    .set({ pushoverToken: appToken, pushoverUserKey: userKey }, { merge: true });
  // Non-secret mirror so the settings UI can show "configured" without
  // reading the secret, which no client is allowed to do.
  await projectRef.set({ pushoverConfigured: true }, { merge: true });

  console.log(`${notifySecretsPath(projectId)}`);
  console.log(`  pushoverToken    = ${mask(appToken)}  ✓ written`);
  console.log(`  pushoverUserKey  = ${mask(userKey)}  ✓ written`);
  console.log(`projects/${projectId}.pushoverConfigured = true  ✓ written`);
  console.log(
    "\nNext: enable Pushover in the project's Settings page, then opt into\n" +
      "Critical Alerts inside the Pushover iOS app — Apple requires that\n" +
      "consent separately, and without it priority 1 and 2 stay SILENT on mute."
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
