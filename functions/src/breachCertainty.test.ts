import { describe, it, expect } from "vitest";
import {
  isDefiniteBreach,
  alarmSeverity,
  breachVerdictSeverity,
  resolveCauseCertainty,
} from "./breachCertainty";

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

  it("is definite for a definite sensor", () => {
    expect(
      resolveCauseCertainty({ rfId: "0x2E5B7", at: 1 }, sensorsById, sensorIdsByRfId)
    ).toBe(true);
  });

  it("is non-definite for a non-definite sensor", () => {
    expect(
      resolveCauseCertainty({ rfId: "0x0061D", at: 1 }, sensorsById, sensorIdsByRfId)
    ).toBe(false);
  });

  it("is definite for a sensor with no flag set", () => {
    expect(
      resolveCauseCertainty({ rfId: "0xAAAAA", at: 1 }, sensorsById, sensorIdsByRfId)
    ).toBe(true);
  });

  // THE REGRESSION THIS FIXES. An earlier version resolved the tier from the
  // first rule containing the sensor, but rule membership is not exclusive —
  // a sensor commonly sits in a 1-member count_in_window AND a multi_sensor
  // rule at once — so Firestore's arbitrary document order decided the
  // priority, and the same sensor could alert differently on each trigger.
  //
  // The result now depends only on the sensor, so no rule arrangement can
  // change it. Called repeatedly to make the determinism explicit.
  it("is deterministic regardless of how many rules cover the sensor", () => {
    const runs = Array.from({ length: 5 }, () =>
      resolveCauseCertainty({ rfId: "0x0061D", at: 1 }, sensorsById, sensorIdsByRfId)
    );
    expect(runs).toEqual([false, false, false, false, false]);
  });

  // --- unknowns, all fail loud ---

  it("is definite for a null cause", () => {
    expect(resolveCauseCertainty(null, sensorsById, sensorIdsByRfId)).toBe(true);
  });

  // A tamper cause, and every pre-fix server write: label only, no rfId.
  it("is definite for a cause carrying only a label", () => {
    expect(
      resolveCauseCertainty(
        { label: "Front door tampered", at: 1 },
        sensorsById,
        sensorIdsByRfId
      )
    ).toBe(true);
  });

  it("is definite for an rfId matching no sensor", () => {
    expect(
      resolveCauseCertainty({ rfId: "0xDEAD0", at: 1 }, sensorsById, sensorIdsByRfId)
    ).toBe(true);
  });

  // A label AND an rfId is what the server writes. The rfId must win for
  // certainty, even though resolveCauseLabel prefers the label for DISPLAY.
  it("uses the rfId for certainty even when a label is also present", () => {
    expect(
      resolveCauseCertainty(
        { label: "Night motion", rfId: "0x0061D", at: 1 },
        sensorsById,
        sensorIdsByRfId
      )
    ).toBe(false);
  });
});
