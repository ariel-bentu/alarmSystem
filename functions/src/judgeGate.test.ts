import { describe, it, expect } from "vitest";
import {
  shouldJudge,
  reusableVerdict,
  breachSatisfiesAny,
  type ChannelVerdictRecord,
} from "./judgeGate";
import { Rule } from "./types";

const TS = 1_791_209_562_000;

describe("shouldJudge", () => {
  // The gate changed from "did THIS trigger alarm?" to "was the system
  // armed?". The old gate made the judge structurally unreachable for
  // count_in_window rules: trigger 1 captures but has no alarm_cause yet, and
  // trigger 2 alarms but is inside the capture cooldown so has no images.
  it("judges an armed trigger even with no alarm", () => {
    expect(shouldJudge({ armed: true, nvrMode: "capture+judge" })).toBe(true);
  });

  it("does not judge while disarmed", () => {
    expect(shouldJudge({ armed: false, nvrMode: "capture+judge" })).toBe(false);
  });

  it("does not judge unless the project is in capture+judge", () => {
    expect(shouldJudge({ armed: true, nvrMode: "capture" })).toBe(false);
    expect(shouldJudge({ armed: true, nvrMode: "off" })).toBe(false);
    expect(shouldJudge({ armed: true, nvrMode: undefined })).toBe(false);
  });
});

describe("reusableVerdict", () => {
  // A trigger arriving inside captureCooldownSec CANNOT have images of its
  // own, so the previous verdict is the only evidence that exists. The reuse
  // window is therefore derived from the cooldown, not a separate knob.
  const prior: ChannelVerdictRecord = {
    ts: TS,
    verdict: "breach",
    reason: "person near the shed",
  };

  it("reuses a verdict from within the cooldown window", () => {
    // New trigger 6s later, cooldown 10s -> no fresh images possible.
    expect(reusableVerdict([prior], TS + 6_000, 10)).toEqual(prior);
  });

  it("does not reuse a verdict older than the cooldown", () => {
    // 15s later with a 10s cooldown: fresh images WERE obtainable, so this
    // trigger gets its own verdict rather than inheriting a stale one.
    expect(reusableVerdict([prior], TS + 15_000, 10)).toBe(null);
  });

  // Judge latency: a trigger past the cooldown gets fresh images, but the
  // verdict takes a few seconds to land (~4-7s measured). During that gap the
  // previous verdict is still the best evidence available.
  it("allows for judge latency past the cooldown", () => {
    expect(reusableVerdict([prior], TS + 13_000, 10, 5)).toEqual(prior);
    expect(reusableVerdict([prior], TS + 20_000, 10, 5)).toBe(null);
  });

  it("picks the most recent prior verdict", () => {
    const older: ChannelVerdictRecord = { ts: TS - 5_000, verdict: "safe", reason: "empty" };
    const newer: ChannelVerdictRecord = { ts: TS, verdict: "breach", reason: "person" };
    expect(reusableVerdict([older, newer], TS + 3_000, 10)).toEqual(newer);
    expect(reusableVerdict([newer, older], TS + 3_000, 10)).toEqual(newer);
  });

  it("returns null with no prior verdicts", () => {
    expect(reusableVerdict([], TS, 10)).toBe(null);
  });

  // Never reuse a verdict from the FUTURE relative to this trigger: that
  // would be a later episode's evidence bleeding backwards.
  it("ignores verdicts newer than the trigger", () => {
    expect(reusableVerdict([{ ...prior, ts: TS + 5_000 }], TS, 10)).toBe(null);
  });
});

describe("breachSatisfiesAny", () => {
  // Resolution is OR across every condition covering the sensor. alarm_cause
  // records `ct` (a condition TYPE index, not a rule id), so the firing rule
  // cannot be identified from the cause -- the same limitation that reverted
  // rule-derived certainty on 2026-10-04. It does not need to be.
  const countFlagged: Rule = {
    id: "r1",
    name: "",
    sensors: ["s1"],
    condition: {
      type: "count_in_window",
      count: 2,
      window_sec: 30,
      min_gap_sec: 15,
      breach_satisfies: true,
    },
  };
  const multiPlain: Rule = {
    id: "r2",
    name: "תנועה במרפסת x2",
    sensors: ["s1", "s2", "s3"],
    condition: { type: "multi_sensor", window_sec: 30 },
  };
  const multiFlagged: Rule = {
    id: "r3",
    name: "תנועה באיזור הדלת x2",
    sensors: ["s1", "s2"],
    condition: { type: "multi_sensor", window_sec: 30, breach_satisfies: true },
  };

  it("fires when the sensor's count_in_window condition is flagged", () => {
    expect(breachSatisfiesAny([countFlagged], "s1")).toBe(true);
  });

  it("fires when a multi_sensor condition is flagged", () => {
    // One participant's breach satisfies the WHOLE rule: the AND exists
    // because one PIR is noisy, and vision removes exactly that noise.
    expect(breachSatisfiesAny([multiFlagged], "s1")).toBe(true);
    expect(breachSatisfiesAny([multiFlagged], "s2")).toBe(true);
  });

  it("does not fire when no covering condition is flagged", () => {
    expect(breachSatisfiesAny([multiPlain], "s1")).toBe(false);
  });

  // The real overlap in this project: חלון מרפסת and תנועה דלת כניסה each sit
  // in a flagged count_in_window AND an unflagged multi_sensor.
  it("fires via OR when only ONE of several covering conditions is flagged", () => {
    expect(breachSatisfiesAny([countFlagged, multiPlain], "s1")).toBe(true);
  });

  // Order must not matter. Firestore document order is exactly what made the
  // old rules.find() approach non-deterministic (2026-10-04).
  it("is independent of rule order", () => {
    expect(breachSatisfiesAny([multiPlain, countFlagged], "s1")).toBe(true);
    expect(breachSatisfiesAny([countFlagged, multiPlain], "s1")).toBe(true);
  });

  it("ignores conditions the sensor does not belong to", () => {
    // s3 is only in the unflagged multi_sensor, not the flagged count rule.
    expect(breachSatisfiesAny([countFlagged, multiPlain], "s3")).toBe(false);
  });

  it("is false for an unknown sensor", () => {
    expect(breachSatisfiesAny([countFlagged], "nope")).toBe(false);
  });

  it("is false with no rules at all", () => {
    expect(breachSatisfiesAny([], "s1")).toBe(false);
  });
});
