/**
 * Remove duplicate sensor docs that share one 20-bit family, and reconcile the
 * rules that reference the copies being deleted.
 *
 * Why this exists: the pairing dialog had no in-flight guard, so two clicks
 * 1.5s apart created two identical docs for family 0x309A0 (2026-09-25), each
 * with its own rule in every profile. SensorsTab now refuses both the double
 * submit and an already-paired family, so this is a one-off repair.
 *
 * DRY RUN BY DEFAULT — prints the plan and exits. Pass --apply to write.
 *
 * The keeper is the EARLIEST pairedAt in each family: the first click is the
 * one the user meant, and any later edits (name, battery date, alert days)
 * were made against the row the list rendered first.
 *
 * Rule reconciliation is NOT reimplemented here — it calls the same
 * `reconcileRulesForRemovedSensor` that `handleUnpair` uses, so per-sensor
 * `counts` and `quorum` on a multi_sensor rule are cleaned up identically and
 * the two paths cannot drift.
 *
 * ONE thing the unpair path does not have to worry about, and this does:
 * `always`. The 0x309A0 twins were edited AFTER the double click, and the
 * always-on flag — the whole point of a smoke detector, "fires even while
 * disarmed" — was set on the doc that sorts LATER and would be deleted.
 * Dropping it would quietly leave that detector armed-only, so an always-on
 * single-sensor rule on a doomed twin is carried over to the keeper's
 * equivalent rule before the delete. See --apply output for what moved.
 */

import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore, type Firestore } from "firebase-admin/firestore";
import { createRequire } from "module";
import { reconcileRulesForRemovedSensor } from "../../web/src/features/configure/profileRules";
import type { Rule } from "../../web/src/types";

const require = createRequire(import.meta.url);

const SA_PATH =
  process.env.GOOGLE_APPLICATION_CREDENTIALS ??
  "/Users/i022021/dev/alarmSystem/alarm-system-100-firebase-adminsdk-fbsvc-4967b8811f.json";

const APPLY = process.argv.includes("--apply");

function familyIdOf(rfId: string): string | null {
  const c = String(rfId ?? "").trim();
  if (!/^0[xX][0-9a-fA-F]{1,8}$/.test(c)) return null;
  const v = parseInt(c, 16);
  if (!Number.isFinite(v)) return null;
  return (
    "0x" +
    (((v >>> 4) & 0xfffff) >>> 0).toString(16).toUpperCase().padStart(5, "0")
  );
}

function normaliseFamilyId(value: string): string | null {
  const c = String(value ?? "").trim();
  if (!/^0[xX][0-9a-fA-F]{5}$/.test(c)) return null;
  return "0x" + c.slice(2).toUpperCase();
}

type SensorDoc = {
  id: string;
  rfId: string;
  familyId?: string | null;
  name?: string;
  pairedAtMs: number;
};

function familyOf(s: SensorDoc): string {
  return (
    (s.familyId ? normaliseFamilyId(s.familyId) : null) ??
    familyIdOf(s.rfId) ??
    s.rfId.trim()
  );
}

async function main() {
  const sa = require(SA_PATH);
  initializeApp({ credential: cert(sa) });
  const db: Firestore = getFirestore();

  console.log(APPLY ? "=== APPLY (writing) ===" : "=== DRY RUN (no writes) ===");

  const projects = await db.collection("projects").get();

  for (const project of projects.docs) {
    const sensorsSnap = await project.ref.collection("sensors").get();
    const sensors: SensorDoc[] = sensorsSnap.docs.map((d) => {
      const data = d.data() as Record<string, any>;
      return {
        id: d.id,
        rfId: String(data.rfId ?? ""),
        familyId: data.familyId ?? null,
        name: data.name,
        pairedAtMs: data.pairedAt?.toMillis?.() ?? 0,
      };
    });

    const byFamily = new Map<string, SensorDoc[]>();
    for (const s of sensors) {
      const key = familyOf(s);
      byFamily.set(key, [...(byFamily.get(key) ?? []), s]);
    }

    const doomed: SensorDoc[] = [];
    for (const [family, group] of byFamily) {
      if (group.length < 2) continue;
      const sorted = [...group].sort((a, b) => a.pairedAtMs - b.pairedAtMs);
      const [keeper, ...rest] = sorted;
      console.log(`\nproject ${project.id}  family ${family}`);
      console.log(
        `  KEEP   ${keeper.id}  ${JSON.stringify(keeper.name)}  rfId=${keeper.rfId}  pairedAt=${new Date(keeper.pairedAtMs).toISOString()}`
      );
      for (const d of rest) {
        console.log(
          `  DELETE ${d.id}  ${JSON.stringify(d.name)}  rfId=${d.rfId}  pairedAt=${new Date(d.pairedAtMs).toISOString()}`
        );
        doomed.push(d);
      }
    }

    if (doomed.length === 0) {
      console.log(`project ${project.id}: no duplicate families`);
      continue;
    }

    // Plan the rule changes, one doomed sensor at a time, feeding each result
    // into the next so a rule naming two doomed sensors is handled correctly.
    const profilesSnap = await project.ref.collection("profiles").get();
    const plan: {
      profileId: string;
      deletes: string[];
      updates: Rule[];
    }[] = [];

    // family -> keeper id, so a doomed twin's flags can be moved to the row
    // that survives.
    const keeperByFamily = new Map<string, string>();
    for (const [family, group] of byFamily) {
      if (group.length < 2) continue;
      const sorted = [...group].sort((a, b) => a.pairedAtMs - b.pairedAtMs);
      keeperByFamily.set(family, sorted[0].id);
    }
    const keeperOfDoomed = new Map(
      doomed.map((d) => [d.id, keeperByFamily.get(familyOf(d))!])
    );

    for (const p of profilesSnap.docs) {
      const rulesSnap = await p.ref.collection("rules").get();
      let rules: Rule[] = rulesSnap.docs.map(
        (d) => ({ ...(d.data() as object), id: d.id }) as Rule
      );
      const deleteIds = new Set<string>();

      // Carry `always` from a doomed twin's single-sensor rule onto the
      // keeper's, BEFORE reconciling — otherwise the flag disappears with the
      // rule. Only single-sensor rules: `always` is meaningless on
      // multi_sensor, and the editor forbids it there.
      for (const s of doomed) {
        const keeperId = keeperOfDoomed.get(s.id);
        if (!keeperId) continue;
        const doomedAlways = rules.find(
          (r) => r.sensors.length === 1 && r.sensors[0] === s.id && r.always
        );
        if (!doomedAlways) continue;
        const target = rules.find(
          (r) => r.sensors.length === 1 && r.sensors[0] === keeperId
        );
        if (!target || target.always) continue;
        console.log(
          `    CARRY always=true from rule ${doomedAlways.id} onto keeper rule ${target.id} (profile ${p.id})`
        );
        rules = rules.map((r) =>
          r.id === target.id ? { ...r, always: true } : r
        );
      }

      for (const s of doomed) {
        const recon = reconcileRulesForRemovedSensor(rules, s.id);
        for (const r of recon.toDelete) deleteIds.add(r.id);
        const updated = new Map(recon.toUpdate.map((r) => [r.id, r]));
        rules = rules
          .filter((r) => !deleteIds.has(r.id))
          .map((r) => updated.get(r.id) ?? r);
      }

      const originals = new Map(
        rulesSnap.docs.map((d) => [d.id, JSON.stringify(d.data())])
      );
      const updates = rules.filter((r) => {
        const { id, ...rest } = r;
        return originals.get(id) !== JSON.stringify(rest);
      });

      if (deleteIds.size || updates.length) {
        plan.push({
          profileId: p.id,
          deletes: [...deleteIds],
          updates,
        });
      }
    }

    const totalDeletes = plan.reduce((n, p) => n + p.deletes.length, 0);
    const totalUpdates = plan.reduce((n, p) => n + p.updates.length, 0);
    console.log(
      `\n  rules: ${totalDeletes} to delete, ${totalUpdates} to rewrite`
    );
    for (const p of plan) {
      for (const id of p.deletes)
        console.log(`    DELETE profiles/${p.profileId}/rules/${id}`);
      for (const r of p.updates)
        console.log(
          `    UPDATE profiles/${p.profileId}/rules/${r.id} -> sensors=${JSON.stringify(r.sensors)} condition=${JSON.stringify(r.condition)} always=${r.always}`
        );
    }

    if (!APPLY) continue;

    const batch = db.batch();
    for (const p of plan) {
      const rulesCol = project.ref
        .collection("profiles")
        .doc(p.profileId)
        .collection("rules");
      for (const id of p.deletes) batch.delete(rulesCol.doc(id));
      for (const r of p.updates) {
        const { id, ...rest } = r;
        batch.update(rulesCol.doc(id), rest as Record<string, unknown>);
      }
    }
    for (const s of doomed)
      batch.delete(project.ref.collection("sensors").doc(s.id));
    await batch.commit();
    console.log(
      `  APPLIED: ${doomed.length} sensor(s), ${totalDeletes} rule delete(s), ${totalUpdates} rule update(s)`
    );
  }

  if (!APPLY) {
    console.log("\nDry run only. Re-run with --apply to write.");
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
