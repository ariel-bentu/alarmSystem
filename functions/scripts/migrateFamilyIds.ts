#!/usr/bin/env npx tsx
//
// One-shot backfill: give every sensor doc a `familyId` (its 20-bit
// identity), so matching stops using the full 24-bit rfId — whose bottom
// nibble is an EVENT code, not identity.
//
// A SCRIPT, not a Cloud Function: it runs once, by hand, against a known
// dataset. A Function would sit in the deployment forever re-checking work
// that was already done.
//
//   npx tsx scripts/migrateFamilyIds.ts              # dry run (default)
//   npx tsx scripts/migrateFamilyIds.ts --commit     # write
//   npx tsx scripts/migrateFamilyIds.ts --rollback   # delete familyId again
//
// Needs admin credentials, e.g.
//   export GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account.json
//   export GOOGLE_CLOUD_PROJECT=alarm-system-100
//
// WHAT IT DOES NOT TOUCH, all verified against live data before writing:
//   - profiles/{id}/rules  — reference Firestore sensorIds, never rfIds, and
//     every `condition.counts` was undefined. buildConfig.ts already
//     resolves sensorId -> rfId at config-build time, so the indirection
//     exists. Had `counts` been keyed by rfId, every multi_sensor rule would
//     have needed rewriting; it is not.
//   - schedules — profileId only.
//   - Firestore events — append-only history. The rfId on a 2026-08 event is
//     a true statement about what was received; rewriting it to a field that
//     did not exist then would be a lie, and the timeline reads sensorId.
//   - RTDB /events/{rfId} keys — stay full 24-bit, deliberately. The pairing
//     UI reads them to discover unpaired sensors, and the EVENT CODE IS THE
//     INFORMATION: 0x0061DB appearing is how a tamper is seen at all.
//   - RTDB /config — derived state, rewritten by buildConfig on the next
//     config change.
//
// ROLLBACK: deleting familyId from every sensor doc restores the previous
// state exactly, because nothing else is modified. Note the FIRMWARE is not
// rollback-safe in the same way, which is why it ships last.

import { initializeApp, applicationDefault, getApps } from "firebase-admin/app";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import {
  planMigration,
  writesOf,
  unmappedNibbles,
  MigrationSensor,
} from "../src/migrateFamilyIds";

const args = new Set(process.argv.slice(2));
const commit = args.has("--commit");
const rollback = args.has("--rollback");

if (commit && rollback) {
  console.error("--commit and --rollback are mutually exclusive.");
  process.exit(2);
}

if (getApps().length === 0) {
  initializeApp({ credential: applicationDefault() });
}
const db = getFirestore();

async function main(): Promise<number> {
  const projects = await db.collection("projects").get();
  if (projects.empty) {
    console.error("No projects found — check GOOGLE_CLOUD_PROJECT.");
    return 1;
  }

  let exitCode = 0;
  let totalWrites = 0;

  for (const project of projects.docs) {
    const sensorsSnap = await db
      .collection(`projects/${project.id}/sensors`)
      .get();
    const sensors: MigrationSensor[] = sensorsSnap.docs.map((d) => ({
      id: d.id,
      rfId: String(d.data().rfId ?? ""),
      name: d.data().name,
      familyId: d.data().familyId,
    }));

    console.log(
      `\n=== project ${project.id} (${sensorsSnap.size} sensors) ===`
    );

    if (rollback) {
      const withField = sensorsSnap.docs.filter(
        (d) => d.data().familyId !== undefined
      );
      console.log(`  rollback: ${withField.length} docs carry familyId`);
      const batch = db.batch();
      for (const d of withField) {
        console.log(`  - ${d.id} (${d.data().name ?? ""})`);
        batch.update(d.ref, { familyId: FieldValue.delete() });
      }
      if (withField.length > 0) {
        await batch.commit();
        console.log(`  rolled back ${withField.length} docs`);
      }
      continue;
    }

    const plan = planMigration(sensors);

    // The table the operator actually reads before typing --commit.
    for (const row of plan.rows) {
      const mark =
        row.action === "error" ? "!!" : row.action === "skip" ? "  " : "->";
      console.log(
        `  ${mark} ${row.rfId.padEnd(10)} ${String(row.familyId).padEnd(9)}` +
          ` nibble=${row.nibble === null ? "?" : "0x" + row.nibble.toString(16).toUpperCase()}` +
          ` ${row.event.padEnd(12)} ${row.name}`
      );
    }

    for (const row of unmappedNibbles(plan)) {
      // A warning, not a failure. The smoke detector sits here: never fired
      // in 3,089 events, so its nibble is unverified, but UNKNOWN routes to
      // "trigger" so its always-rule keeps working.
      console.warn(
        `  WARN ${row.rfId} (${row.name}) has nibble ` +
          `${row.nibble === null ? "?" : "0x" + row.nibble.toString(16).toUpperCase()},` +
          ` which is in no event table. It will be treated as a trigger.`
      );
    }

    if (plan.refused) {
      exitCode = 1;
      for (const c of plan.collisions) {
        console.error(
          `  ERROR family ${c.familyId} is claimed by ${c.sensors.length} sensors:`
        );
        for (const s of c.sensors) {
          console.error(`    - ${s.id} ${s.rfId} ${s.name ?? ""}`);
        }
      }
      for (const row of plan.rows.filter((r) => r.action === "error")) {
        console.error(`  ERROR ${row.sensorId}: unparseable rfId "${row.rfId}"`);
      }
      console.error(
        `  REFUSED: nothing written for project ${project.id}. ` +
          `Resolve the above by hand first.`
      );
      continue;
    }

    const writes = writesOf(plan);
    totalWrites += writes.length;
    console.log(
      `  ${writes.length} to write, ` +
        `${plan.rows.length - writes.length} already correct`
    );

    if (commit && writes.length > 0) {
      const batch = db.batch();
      for (const row of writes) {
        batch.update(
          db.doc(`projects/${project.id}/sensors/${row.sensorId}`),
          { familyId: row.familyId }
        );
      }
      await batch.commit();
      console.log(`  committed ${writes.length} docs`);
    }
  }

  if (!commit && !rollback) {
    console.log(
      `\nDRY RUN — ${totalWrites} docs would be written. ` +
        `Re-run with --commit to apply.`
    );
  }
  return exitCode;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
