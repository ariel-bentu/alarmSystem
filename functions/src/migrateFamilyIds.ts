// Pure planning logic for the one-shot familyId backfill.
//
// Split from the script that runs it (functions/scripts/migrateFamilyIds.ts)
// so the decisions — what to write, what to skip, when to REFUSE — are unit
// tested, while the script stays a thin Firestore read/write wrapper. The
// refusal in particular must not be discovered for the first time against a
// live database.
//
// This is a script, not a Cloud Function: it runs once, by hand, against a
// known dataset. A Function would sit in the deployment forever re-checking
// work that was already done.

import { familyIdOf, nibbleOf, keruiEventOf, KeruiEvent } from "./keruiEvent";

/** The subset of a sensor doc the migration needs. */
export interface MigrationSensor {
  id: string;
  rfId: string;
  name?: string;
  familyId?: string;
}

export interface MigrationRow {
  sensorId: string;
  name: string;
  rfId: string;
  /** Null when rfId is unparseable — such a row is always an error. */
  familyId: string | null;
  nibble: number | null;
  event: KeruiEvent;
  /**
   * write  — familyId is absent or wrong and will be set
   * skip   — the doc already carries the correct familyId (re-run safe)
   * error  — rfId cannot be parsed; the script writes nothing for it
   */
  action: "write" | "skip" | "error";
}

export interface MigrationPlan {
  rows: MigrationRow[];
  /**
   * Families claimed by more than one sensor in the SAME project. Non-empty
   * means the whole project is refused: two sensors sharing a family would
   * both match every packet from it, and picking a winner is a decision for
   * a human, not a script.
   *
   * Verified empty against the live project (12 sensors, 12 distinct
   * families), so this guards a future re-run rather than today's data.
   */
  collisions: Array<{ familyId: string; sensors: MigrationSensor[] }>;
  /** True when nothing may be written — a collision, or an unparseable rfId. */
  refused: boolean;
}

/**
 * Plan one project's migration. Pure: no I/O, no clock, no randomness.
 *
 * Idempotent by construction — a sensor that already holds the right
 * familyId is planned as "skip", so re-running is safe and writes nothing.
 */
export function planMigration(sensors: MigrationSensor[]): MigrationPlan {
  const rows: MigrationRow[] = sensors.map((s) => {
    const familyId = familyIdOf(s.rfId);
    const nibble = nibbleOf(s.rfId);
    return {
      sensorId: s.id,
      name: s.name ?? "",
      rfId: s.rfId,
      familyId,
      nibble,
      event: nibble === null ? "unknown" : keruiEventOf(nibble),
      action:
        familyId === null
          ? "error"
          : s.familyId === familyId
            ? "skip"
            : "write",
    };
  });

  // Group by family to find sensors that would collide. Only parseable rows
  // participate: an unparseable rfId is its own error, not a collision.
  const byFamily = new Map<string, MigrationSensor[]>();
  for (const s of sensors) {
    const familyId = familyIdOf(s.rfId);
    if (familyId === null) continue;
    const bucket = byFamily.get(familyId);
    if (bucket) bucket.push(s);
    else byFamily.set(familyId, [s]);
  }

  const collisions = [...byFamily.entries()]
    .filter(([, group]) => group.length > 1)
    .map(([familyId, group]) => ({ familyId, sensors: group }));

  return {
    rows,
    collisions,
    refused: collisions.length > 0 || rows.some((r) => r.action === "error"),
  };
}

/** The rows a --commit run would actually write. Empty when refused. */
export function writesOf(plan: MigrationPlan): MigrationRow[] {
  if (plan.refused) return [];
  return plan.rows.filter((r) => r.action === "write");
}

/**
 * Nibbles present on paired sensors but absent from the event table. Printed
 * as a warning, NOT an error: the smoke detector sits on 0x2 and has never
 * fired in 3,089 events, so its nibble is unverified but its pairing is
 * still assumed correct. 0x2 maps to UNKNOWN, which callers route to
 * "trigger", so its always-rule keeps working.
 */
export function unmappedNibbles(plan: MigrationPlan): MigrationRow[] {
  return plan.rows.filter((r) => r.action !== "error" && r.event === "unknown");
}
