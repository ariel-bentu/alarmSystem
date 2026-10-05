#!/usr/bin/env npx tsx
//
// One-off: dump every event / timeline row / sensor-config fact around a
// given wall-clock window, so an alarm can be reconstructed from data.
//
//   GOOGLE_APPLICATION_CREDENTIALS=... npx tsx scripts/analyzeWindow.ts \
//     2026-10-05T05:40 2026-10-05T06:10

import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { getDatabase } from "firebase-admin/database";

const keyPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
if (!keyPath) {
  console.error("Set GOOGLE_APPLICATION_CREDENTIALS.");
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

const TZ = "Asia/Jerusalem";
const fmt = (ms: number) =>
  new Date(ms).toLocaleString("en-GB", { timeZone: TZ, hour12: false }) +
  `.${String(ms % 1000).padStart(3, "0")}`;

function parseLocal(s: string): number {
  // interpret the given naive timestamp as Asia/Jerusalem by solving for the
  // epoch whose local rendering equals the input
  let t = new Date(s + "Z").getTime();
  for (let i = 0; i < 3; i++) {
    const local = new Date(t).toLocaleString("sv-SE", { timeZone: TZ }).replace(" ", "T");
    const drift = new Date(local + "Z").getTime() - new Date(s + "Z").getTime();
    t -= drift;
  }
  return t;
}

async function main() {
  const [fromS, toS] = process.argv.slice(2);
  const from = parseLocal(fromS);
  const to = parseLocal(toS);
  console.log(`window ${fmt(from)} .. ${fmt(to)} (${from}..${to})`);

  const db = getFirestore();
  const rtdb = getDatabase();

  for (const p of (await db.collection("projects").get()).docs) {
    const projectId = p.id;
    const pd = p.data();
    console.log(`\n================ project ${projectId} ================`);
    console.log(
      `nvrMode=${pd.nvrMode} judge=${pd.judgeProvider}/${pd.judgeModel} ` +
        `cooldown=${pd.snapshotCooldownSec} triggerSiren=${pd.serverActions?.triggerSiren} ` +
        `notifyChannels=${JSON.stringify(pd.notifyChannels)}`
    );
    console.log(`judgePrompt=${JSON.stringify(pd.judgePrompt ?? null)}`);
    console.log(`cameraNames=${JSON.stringify(pd.cameraNames ?? null)}`);

    // ---- sensors
    const sensors = await db.collection(`projects/${projectId}/sensors`).get();
    const byFamily = new Map<string, any>();
    const byId = new Map<string, any>();
    for (const s of sensors.docs) {
      const d = s.data();
      byId.set(s.id, { id: s.id, ...d });
      const fam = d.familyId ?? String(d.rfId ?? "").slice(0, -1);
      byFamily.set(fam, { id: s.id, ...d });
    }

    // ---- RTDB events in window
    console.log(`\n--- RTDB events ---`);
    const evSnap = await rtdb.ref(`${projectId}/events`).get();
    const evs: any[] = [];
    evSnap.forEach((rfNode) => {
      rfNode.forEach((tsNode) => {
        const ts = Number(tsNode.key);
        if (ts >= from && ts <= to) {
          evs.push({ rfId: rfNode.key, ts, ...tsNode.val() });
        }
        return false;
      });
      return false;
    });
    evs.sort((a, b) => a.ts - b.ts);
    for (const e of evs) {
      const fam = String(e.rfId).slice(0, -1);
      const s = byFamily.get(fam);
      console.log(
        `  ${fmt(e.ts)}  ${e.rfId}  ${e.event ?? "?"}  rssi=${e.rssi ?? "-"} ` +
          `batt_low=${e.battery_low ?? "-"}  sensor="${s?.name ?? "UNKNOWN"}" ` +
          `definiteBreach=${s?.definiteBreach} cameras=${JSON.stringify(s?.cameras ?? null)}`
      );
    }

    // ---- Firestore timeline in window
    console.log(`\n--- Firestore timeline ---`);
    const tl = await db
      .collection(`projects/${projectId}/timeline`)
      .where("at", ">=", new Date(from))
      .where("at", "<=", new Date(to))
      .orderBy("at")
      .get();
    for (const t of tl.docs) {
      const d: any = t.data();
      const at = d.at?.toMillis ? d.at.toMillis() : d.at;
      const { at: _a, ...rest } = d;
      console.log(`  ${fmt(at)}  [${t.id}]`);
      console.log(`      ${JSON.stringify(rest)}`);
    }

    // ---- Firestore events mirror in window
    console.log(`\n--- Firestore events mirror ---`);
    try {
      const fe = await db
        .collection(`projects/${projectId}/events`)
        .where("at", ">=", new Date(from))
        .where("at", "<=", new Date(to))
        .orderBy("at")
        .get();
      for (const t of fe.docs) {
        console.log(`  [${t.id}] ${JSON.stringify(t.data())}`);
      }
    } catch (e: any) {
      console.log(`  (query failed: ${e.message})`);
    }

    // ---- current RTDB state
    console.log(`\n--- RTDB state / commands / config ---`);
    for (const k of ["state", "commands", "config"]) {
      const v = (await rtdb.ref(`${projectId}/${k}`).get()).val();
      console.log(`  ${k} = ${JSON.stringify(v)}`);
    }

    // ---- profiles + rules
    console.log(`\n--- profiles / rules ---`);
    for (const prof of (await db.collection(`projects/${projectId}/profiles`).get()).docs) {
      const pdp: any = prof.data();
      console.log(
        `  profile ${prof.id} "${pdp.displayName ?? pdp.name}" activeOnDevice=${pdp.isActiveOnDevice} enabled=${pdp.enabled}`
      );
      for (const r of (
        await db.collection(`projects/${projectId}/profiles/${prof.id}/rules`).get()
      ).docs) {
        const rd: any = r.data();
        const names = (rd.sensors ?? []).map((sid: string) => byId.get(sid)?.name ?? `MISSING(${sid})`);
        console.log(
          `    rule "${rd.name}" always=${rd.always === true} ${JSON.stringify(rd.condition)} sensors=[${names.join(", ")}]`
        );
      }
    }

    // ---- all sensors summary
    console.log(`\n--- sensors ---`);
    for (const s of [...byId.values()].sort((a, b) =>
      String(a.name).localeCompare(String(b.name))
    )) {
      console.log(
        `  ${String(s.rfId).padEnd(10)} fam=${s.familyId ?? "-"} "${s.name}" ` +
          `definiteBreach=${s.definiteBreach} cameras=${JSON.stringify(s.cameras ?? null)}`
      );
    }
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
