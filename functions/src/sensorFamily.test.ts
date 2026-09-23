import { describe, it, expect } from "vitest";
import { sensorFamilyId, findSensorByFamily } from "./sensorFamily";

const sensor = (rfId: string, familyId?: string) => ({ rfId, familyId });

describe("sensorFamilyId", () => {
  it("prefers the stored familyId", () => {
    expect(sensorFamilyId(sensor("0x0061DA", "0x0061D"))).toBe("0x0061D");
  });

  it("derives one from rfId when the doc predates the migration", () => {
    // This fallback is what makes the cloud half deployable BEFORE the
    // migration runs, and what makes a half-finished migration degrade to
    // "works" rather than "stops matching".
    expect(sensorFamilyId(sensor("0x0061DA"))).toBe("0x0061D");
  });

  it("normalises a stored familyId to upper case", () => {
    // Matching is a string comparison; a hand-edited lower-case doc must not
    // silently stop matching.
    expect(sensorFamilyId(sensor("0x0061DA", "0x0061d"))).toBe("0x0061D");
  });

  it("treats an empty stored familyId as absent", () => {
    expect(sensorFamilyId(sensor("0x0061DA", "  "))).toBe("0x0061D");
  });

  it("returns null when the rfId is unparseable and there is no familyId", () => {
    expect(sensorFamilyId(sensor("REMOTE"))).toBeNull();
  });
});

describe("findSensorByFamily", () => {
  const sensors = [
    sensor("0x0061DA", "0x0061D"),
    sensor("0x2E5B73", "0x2E5B7"),
    sensor("0xCC2682", "0xCC268"),
  ];

  it("matches a sensor on its own paired code", () => {
    expect(findSensorByFamily(sensors, "0x0061DA")).toBe(sensors[0]);
  });

  it("matches the TAMPER code to the sensor paired on its motion code", () => {
    // The bug this whole design exists to fix: 0x0061DB used to match
    // nothing and was logged as an unpaired sensor.
    expect(findSensorByFamily(sensors, "0x0061DB")).toBe(sensors[0]);
  });

  it("matches the door sensor's OPEN code though it was paired on close", () => {
    // Family 0x2E5B7 is paired as 0x2E5B73 (close). Its 12 open events
    // (0x2E5B79) never matched. After this they resolve to the same sensor.
    expect(findSensorByFamily(sensors, "0x2E5B79")).toBe(sensors[1]);
    expect(findSensorByFamily(sensors, "0x2E5B73")).toBe(sensors[1]);
  });

  it("still matches the smoke detector, whose nibble is in no table", () => {
    // Its always-rule must keep firing — there is no live traffic that would
    // reveal a regression, and a silently broken smoke alarm is the worst
    // outcome this refactor could produce.
    expect(findSensorByFamily(sensors, "0xCC2682")).toBe(sensors[2]);
  });

  it("returns null for a genuinely unpaired family", () => {
    expect(findSensorByFamily(sensors, "0x3F0102")).toBeNull();
  });

  it("returns null for a non-hex RTDB key", () => {
    // /events holds "SIREN0" and "REMOTE" keys too; neither is a sensor.
    expect(findSensorByFamily(sensors, "SIREN0")).toBeNull();
    expect(findSensorByFamily(sensors, "REMOTE")).toBeNull();
  });

  it("works against docs with no familyId at all (pre-migration)", () => {
    const unmigrated = [sensor("0x0061DA"), sensor("0x2E5B73")];
    expect(findSensorByFamily(unmigrated, "0x0061DB")).toBe(unmigrated[0]);
  });

  it("picks the first on a collision rather than matching neither", () => {
    // The migration refuses to create this state, so it can only come from a
    // hand-edited doc. Deterministic beats nothing.
    const colliding = [sensor("0x0061DA", "0x0061D"), sensor("0x0061DB", "0x0061D")];
    expect(findSensorByFamily(colliding, "0x0061DE")).toBe(colliding[0]);
  });
});
