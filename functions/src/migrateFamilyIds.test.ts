import { describe, it, expect } from "vitest";
import {
  planMigration,
  writesOf,
  unmappedNibbles,
  MigrationSensor,
} from "./migrateFamilyIds";

// The 12 sensors of the live project, as audited before this was written.
// Kept verbatim because the migration's guarantees ("no collisions", "the
// smoke detector still fires") are claims about THIS data.
const LIVE_SENSORS: MigrationSensor[] = [
  { id: "s1", rfId: "0x2E5B73", name: "new door sensor" },
  { id: "s2", rfId: "0xCC2682", name: "גלאי עשן מסדרון" },
  { id: "s3", rfId: "0x24B47E", name: "חלון קטן חדר עבודה" },
  { id: "s4", rfId: "0x00D91A", name: "תנועה חצר שירות" },
  { id: "s5", rfId: "0x0061DA", name: "PIR salon" },
  { id: "s6", rfId: "0x00927A", name: "PIR hall" },
  { id: "s7", rfId: "0x00216A", name: "PIR 3" },
  { id: "s8", rfId: "0x009BFA", name: "PIR 4" },
  { id: "s9", rfId: "0x4D6A7E", name: "דלת כניסה" },
  { id: "s10", rfId: "0x1520FE", name: "door 2" },
  { id: "s11", rfId: "0x170D09", name: "curtain 1" },
  { id: "s12", rfId: "0x471009", name: "curtain 2" },
];

describe("planMigration", () => {
  it("derives a familyId for every sensor and plans a write", () => {
    const plan = planMigration([{ id: "a", rfId: "0x0061DA" }]);
    expect(plan.rows[0].familyId).toBe("0x0061D");
    expect(plan.rows[0].action).toBe("write");
    expect(plan.refused).toBe(false);
  });

  it("is idempotent — a doc with the correct familyId is skipped", () => {
    // A re-run must write nothing. The script is run by hand and may well be
    // run twice by someone unsure whether the first one took.
    const plan = planMigration([
      { id: "a", rfId: "0x0061DA", familyId: "0x0061D" },
    ]);
    expect(plan.rows[0].action).toBe("skip");
    expect(writesOf(plan)).toEqual([]);
  });

  it("rewrites a WRONG existing familyId rather than trusting it", () => {
    const plan = planMigration([
      { id: "a", rfId: "0x0061DA", familyId: "0xBADBA" },
    ]);
    expect(plan.rows[0].action).toBe("write");
    expect(plan.rows[0].familyId).toBe("0x0061D");
  });

  it("names the event each sensor is paired on", () => {
    const plan = planMigration(LIVE_SENSORS);
    const byId = new Map(plan.rows.map((r) => [r.sensorId, r]));
    // The door sensor paired on its CLOSE code — the audit's key finding.
    expect(byId.get("s1")!.event).toBe("close");
    expect(byId.get("s1")!.familyId).toBe("0x2E5B7");
    // The smoke detector's 0x2 is in no table.
    expect(byId.get("s2")!.event).toBe("unknown");
    expect(byId.get("s5")!.event).toBe("trigger"); // 0xA motion
    expect(byId.get("s9")!.event).toBe("trigger"); // 0xE door
    expect(byId.get("s11")!.event).toBe("trigger"); // 0x9 curtain
  });

  it("finds no collisions in the live project's 12 sensors", () => {
    // The audit's other key result: the migration is mechanical because no
    // two paired sensors share a family today.
    const plan = planMigration(LIVE_SENSORS);
    expect(plan.collisions).toEqual([]);
    expect(plan.refused).toBe(false);
    expect(writesOf(plan)).toHaveLength(12);
    expect(new Set(plan.rows.map((r) => r.familyId)).size).toBe(12);
  });

  it("REFUSES the whole project when two sensors share a family", () => {
    // Two sensors on one family would both match every packet from it.
    // Picking a winner is a human decision, so nothing is written at all —
    // not even the rows that were fine.
    const plan = planMigration([
      { id: "a", rfId: "0x0061DA", name: "motion" },
      { id: "b", rfId: "0x0061DB", name: "tamper mistakenly paired" },
      { id: "c", rfId: "0x2E5B73", name: "unrelated, would be fine" },
    ]);
    expect(plan.refused).toBe(true);
    expect(plan.collisions).toHaveLength(1);
    expect(plan.collisions[0].familyId).toBe("0x0061D");
    expect(plan.collisions[0].sensors.map((s) => s.id)).toEqual(["a", "b"]);
    // The crucial part: the innocent row is NOT written either.
    expect(writesOf(plan)).toEqual([]);
  });

  it("refuses when any rfId is unparseable", () => {
    const plan = planMigration([
      { id: "a", rfId: "0x0061DA" },
      { id: "bad", rfId: "not-hex" },
    ]);
    expect(plan.refused).toBe(true);
    expect(plan.rows.find((r) => r.sensorId === "bad")!.action).toBe("error");
    expect(writesOf(plan)).toEqual([]);
  });

  it("does not count unparseable rfIds as colliding with each other", () => {
    // Two broken docs are two errors, not a family collision — the message
    // the operator gets has to point at the real problem.
    const plan = planMigration([
      { id: "a", rfId: "junk" },
      { id: "b", rfId: "junk" },
    ]);
    expect(plan.collisions).toEqual([]);
    expect(plan.refused).toBe(true);
  });

  it("plans nothing for an empty project", () => {
    const plan = planMigration([]);
    expect(plan.rows).toEqual([]);
    expect(plan.refused).toBe(false);
    expect(writesOf(plan)).toEqual([]);
  });
});

describe("unmappedNibbles", () => {
  it("flags the smoke detector, whose nibble is in no table", () => {
    // A warning, not an error: 0x2 is unverified (never fired in 3,089
    // events) but the pairing is assumed correct, and UNKNOWN routes to
    // "trigger" so the always-rule keeps firing.
    const plan = planMigration(LIVE_SENSORS);
    const flagged = unmappedNibbles(plan);
    expect(flagged.map((r) => r.sensorId)).toEqual(["s2"]);
    expect(flagged[0].nibble).toBe(0x2);
    // And it does NOT block the migration.
    expect(plan.refused).toBe(false);
  });

  it("does not flag rows that failed to parse — those are errors", () => {
    const plan = planMigration([{ id: "bad", rfId: "junk" }]);
    expect(unmappedNibbles(plan)).toEqual([]);
  });
});
