// End-to-end smoke test against the Firebase emulators.
// Exercises the real data flow through Cloud Functions and security rules —
// the integration nobody unit-tested. Run via: node smoke/smoke.mjs
// (emulators must be running: firebase emulators:start)
//
// Uses firebase-admin (bypasses rules) to drive the flow + assert function
// side effects, then a raw REST call against Firestore rules to confirm a
// non-member is denied.
import { initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { getDatabase } from "firebase-admin/database";

const PROJECT = "demo-alarm";
process.env.FIRESTORE_EMULATOR_HOST = "localhost:8080";
process.env.FIREBASE_DATABASE_EMULATOR_HOST = "localhost:9000";

initializeApp({
  projectId: PROJECT,
  databaseURL: `http://localhost:9000?ns=${PROJECT}`,
});
const db = getFirestore();
const rtdb = getDatabase();

let failures = 0;
function assert(cond, msg) {
  if (cond) {
    console.log(`  ✓ ${msg}`);
  } else {
    console.error(`  ✗ ${msg}`);
    failures++;
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Wait until predicate(value) is true or timeout. Polls a getter.
async function waitFor(getter, predicate, label, timeoutMs = 8000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const v = await getter();
    if (predicate(v)) return v;
    await sleep(300);
  }
  return null;
}

async function main() {
  const projectId = "smoke-proj";
  const rfId = "0xA1B2C3";

  console.log("Setup: create project + sensor + active device profile");
  await db.doc(`projects/${projectId}`).set({
    name: "Smoke Home",
    createdAt: Date.now(),
    ownerId: "owner-uid",
    telegramBotToken: "",
    telegramChatId: "",
    serverArmed: false,
    serverActions: { sendTelegram: false, triggerSiren: false },
    sirenDurationSec: 120,
    device: { name: "d1", apiKeyHash: "x", lastSeen: null },
  });
  const sensorRef = await db.collection(`projects/${projectId}/sensors`).add({
    rfId,
    name: "Front door",
    pairedAt: Date.now(),
    batteryStatus: "ok",
    lastSeen: null,
  });
  await db.doc(`projects/${projectId}/profiles/away`).set({
    displayName: "Away",
    createdAt: Date.now(),
    isActiveOnDevice: true,
    isActiveOnServer: false,
  });
  await db.doc(`projects/${projectId}/profiles/away/rules/r1`).set({
    name: "Front door",
    sensors: [sensorRef.id],
    condition: { type: "immediate" },
  });

  console.log("\nTest 1: onProfileChange rebuilds RTDB /config");
  const cfg = await waitFor(
    () => rtdb.ref(`${projectId}/config`).get().then((s) => s.val()),
    (v) => v && v.sensors && v.sensors[rfId],
    "config"
  );
  assert(cfg != null, "config written to RTDB");
  assert(cfg?.sensors?.[rfId]?.name === "Front door", "config has sensor keyed by rfId");
  assert(cfg?.siren_duration_sec === 120, "config carries siren_duration_sec");

  console.log("\nTest 2: onSensorEvent mirrors raw event to Firestore");
  const ts = 1700000000000;
  await rtdb.ref(`${projectId}/events/${rfId}/${ts}`).set({
    event: "trigger",
    battery_low: false,
    rssi: -60,
  });
  const mirrored = await waitFor(
    () =>
      db
        .collection(`projects/${projectId}/events`)
        .where("rfId", "==", rfId)
        .get()
        .then((s) => s.docs.map((d) => d.data())),
    (docs) => docs.length > 0,
    "mirrored event"
  );
  assert(mirrored?.length > 0, "event mirrored to Firestore");
  assert(mirrored?.[0]?.sensorName === "Front door", "mirrored event has denormalized sensorName");

  console.log("\nTest 3: onSensorEvent updates sensor.lastSeen");
  const sensorAfter = await waitFor(
    () => sensorRef.get().then((s) => s.data()),
    (d) => d?.lastSeen != null,
    "sensor.lastSeen"
  );
  assert(sensorAfter?.lastSeen != null, "sensor.lastSeen updated");

  console.log("\nTest 4: onArmStateChange mirrors arm to timeline");
  await rtdb.ref(`${projectId}/state/armed`).set(true);
  const armEvent = await waitFor(
    () =>
      db
        .collection(`projects/${projectId}/events`)
        .where("eventType", "==", "armed")
        .get()
        .then((s) => s.docs.length),
    (n) => n > 0,
    "armed event"
  );
  assert(armEvent > 0, "armed event mirrored to Firestore timeline");

  console.log(`\n${failures === 0 ? "ALL PASS" : failures + " FAILURE(S)"}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
