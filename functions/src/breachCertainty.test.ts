import { describe, it, expect } from "vitest";
import {
  isDefiniteBreach,
  isRuleDefinite,
  alarmSeverity,
  breachVerdictSeverity,
  resolveCauseCertainty,
} from "./breachCertainty";
import type { Rule } from "./types";

const definite = { definiteBreach: true };
const nonDefinite = { definiteBreach: false };
const unset = {};

describe("isDefiniteBreach", () => {
  // The fail-loud default: an unconfigured sensor wakes the owner.
  it("treats an absent flag as definite", () => {
    expect(isDefiniteBreach(unset)).toBe(true);
  });

  it("honours an explicit true", () => {
    expect(isDefiniteBreach(definite)).toBe(true);
  });

  // The ONLY route to the quieter tier.
  it("honours an explicit false", () => {
    expect(isDefiniteBreach(nonDefinite)).toBe(false);
  });

  // A cause that resolved to no sensor at all (deleted, never paired) is an
  // unknown, and unknowns fail loud.
  it("treats null as definite", () => {
    expect(isDefiniteBreach(null)).toBe(true);
  });

  it("treats undefined as definite", () => {
    expect(isDefiniteBreach(undefined)).toBe(true);
  });
});

describe("isRuleDefinite", () => {
  it("is definite when every member is definite", () => {
    expect(isRuleDefinite([definite, definite])).toBe(true);
  });

  // THE assertion that pins the corrected decision. An earlier design
  // defaulted multi-sensor rules to definite on "several conditions at once
  // is stronger evidence" grounds. That is backwards: such a rule exists
  // precisely BECAUSE its members are individually inconclusive, and the
  // condition is an AND, so the weakest member governs.
  it("is NOT definite when any single member is non-definite", () => {
    expect(isRuleDefinite([definite, definite, nonDefinite])).toBe(false);
  });

  it("is not definite when every member is non-definite", () => {
    expect(isRuleDefinite([nonDefinite, nonDefinite])).toBe(false);
  });

  it("takes a single member's certainty verbatim", () => {
    expect(isRuleDefinite([definite])).toBe(true);
    expect(isRuleDefinite([nonDefinite])).toBe(false);
  });

  // An unset member still counts as definite, so a rule mixing one unset
  // sensor with definite ones stays definite.
  it("treats an unset member as definite", () => {
    expect(isRuleDefinite([definite, unset])).toBe(true);
  });

  // No resolvable members is an unknown, not a quiet case.
  it("is definite for an empty member list", () => {
    expect(isRuleDefinite([])).toBe(true);
  });

  it("treats a null member as definite", () => {
    expect(isRuleDefinite([nonDefinite, null])).toBe(false);
    expect(isRuleDefinite([null])).toBe(true);
  });
});

describe("alarmSeverity", () => {
  it("sends emergency for a definite breach", () => {
    expect(alarmSeverity(true)).toBe("alarm");
  });

  it("sends loud-but-not-emergency for a non-definite breach", () => {
    expect(alarmSeverity(false)).toBe("loud");
  });
});

describe("breachVerdictSeverity", () => {
  // The escalation: the priority-1 alarm already went out, and the breach
  // verdict is what raises it to a repeating emergency.
  it("escalates a non-definite sensor to emergency", () => {
    expect(breachVerdictSeverity(false)).toBe("alarm");
  });

  // A definite sensor ALREADY sent priority 2 from onAlarm. A second
  // emergency would mean two repeating alerts for one event.
  it("does not re-escalate a definite sensor", () => {
    expect(breachVerdictSeverity(true)).toBe("loud");
  });
});

describe("resolveCauseCertainty", () => {
  // Mirrors onAlarm's two lookup maps.
  const sensorsById = {
    doorId: { definiteBreach: true },
    motionId: { definiteBreach: false },
    unsetId: {},
  };
  const sensorIdsByRfId = {
    "0x2E5B7": "doorId",
    "0x0061D": "motionId",
    "0xAAAAA": "unsetId",
  };
  const rule = (id: string, sensors: string[]): Rule =>
    ({ id, name: id, sensors, condition: { type: "immediate" } }) as Rule;

  it("is definite for a definite single sensor", () => {
    expect(
      resolveCauseCertainty(
        { rfId: "0x2E5B7", at: 1 },
        [rule("r1", ["doorId"])],
        sensorsById,
        sensorIdsByRfId
      )
    ).toBe(true);
  });

  it("is non-definite for a non-definite single sensor", () => {
    expect(
      resolveCauseCertainty(
        { rfId: "0x0061D", at: 1 },
        [rule("r1", ["motionId"])],
        sensorsById,
        sensorIdsByRfId
      )
    ).toBe(false);
  });

  // The corrected multi-sensor decision, end to end through the lookup.
  it("is non-definite when the covering rule has one non-definite member", () => {
    expect(
      resolveCauseCertainty(
        { rfId: "0x2E5B7", at: 1 },
        [rule("r1", ["doorId", "motionId"])],
        sensorsById,
        sensorIdsByRfId
      )
    ).toBe(false);
  });

  it("is definite when every member of the covering rule is definite", () => {
    expect(
      resolveCauseCertainty(
        { rfId: "0x2E5B7", at: 1 },
        [rule("r1", ["doorId", "unsetId"])],
        sensorsById,
        sensorIdsByRfId
      )
    ).toBe(true);
  });

  // No rule covers it, so fall back to the sensor's own certainty rather
  // than failing loud: the sensor IS resolvable, so this is not an unknown.
  it("falls back to the sensor's own flag when no rule covers it", () => {
    expect(
      resolveCauseCertainty(
        { rfId: "0x0061D", at: 1 },
        [],
        sensorsById,
        sensorIdsByRfId
      )
    ).toBe(false);
  });

  // --- unknowns, all fail loud ---

  it("is definite for a null cause", () => {
    expect(resolveCauseCertainty(null, [], sensorsById, sensorIdsByRfId)).toBe(true);
  });

  // A tamper cause, and every pre-fix server write: label only, no rfId.
  it("is definite for a cause carrying only a label", () => {
    expect(
      resolveCauseCertainty(
        { label: "Front door tampered", at: 1 },
        [],
        sensorsById,
        sensorIdsByRfId
      )
    ).toBe(true);
  });

  it("is definite for an rfId matching no sensor", () => {
    expect(
      resolveCauseCertainty(
        { rfId: "0xDEAD0", at: 1 },
        [],
        sensorsById,
        sensorIdsByRfId
      )
    ).toBe(true);
  });

  // A label AND an rfId is what the server writes after this change. The
  // rfId must win for certainty, even though resolveCauseLabel prefers the
  // label for DISPLAY.
  it("uses the rfId for certainty even when a label is also present", () => {
    expect(
      resolveCauseCertainty(
        { label: "Night motion", rfId: "0x0061D", at: 1 },
        [rule("r1", ["motionId"])],
        sensorsById,
        sensorIdsByRfId
      )
    ).toBe(false);
  });
});
