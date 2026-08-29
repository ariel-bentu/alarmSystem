import { describe, it, expect } from "vitest";
import {
  buildInitialRules,
  conditionParamsValid,
  ruleNameRequired,
  ruleNameValid,
  sensorCountValidForType,
  reconcileRulesForRemovedSensor,
  ruleDisplayName,
} from "./profileRules";
import type { Rule } from "@/types";
import type { Condition } from "@/types";

describe("buildInitialRules", () => {
  it("returns empty array for empty sensorIds", () => {
    expect(buildInitialRules([])).toEqual([]);
  });

  it("creates one rule per sensor with immediate condition", () => {
    const result = buildInitialRules(["sensor-1", "sensor-2"]);
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({
      name: "",
      sensors: ["sensor-1"],
      condition: { type: "immediate" },
    });
    expect(result[1]).toEqual({
      name: "",
      sensors: ["sensor-2"],
      condition: { type: "immediate" },
    });
  });

  it("each rule contains exactly one sensor", () => {
    const result = buildInitialRules(["a", "b", "c"]);
    for (const rule of result) {
      expect(rule.sensors).toHaveLength(1);
    }
  });
});

describe("sensorCountValidForType", () => {
  it("rejects zero sensors for any type", () => {
    expect(sensorCountValidForType("immediate", 0)).toBe(false);
    expect(sensorCountValidForType("multi_sensor", 0)).toBe(false);
  });

  it("requires exactly one sensor for single-sensor types", () => {
    for (const t of ["immediate", "count_in_window", "entry_delay"] as const) {
      expect(sensorCountValidForType(t, 1)).toBe(true);
      expect(sensorCountValidForType(t, 2)).toBe(false);
    }
  });

  it("requires at least two sensors for multi_sensor", () => {
    expect(sensorCountValidForType("multi_sensor", 1)).toBe(false);
    expect(sensorCountValidForType("multi_sensor", 2)).toBe(true);
    expect(sensorCountValidForType("multi_sensor", 3)).toBe(true);
  });
});

describe("ruleNameRequired", () => {
  it("is not required for a single sensor", () => {
    expect(ruleNameRequired(["s1"])).toBe(false);
  });

  it("is not required for no sensors", () => {
    expect(ruleNameRequired([])).toBe(false);
  });

  it("is required for two or more sensors", () => {
    expect(ruleNameRequired(["s1", "s2"])).toBe(true);
    expect(ruleNameRequired(["s1", "s2", "s3"])).toBe(true);
  });
});

describe("ruleNameValid", () => {
  it("accepts an empty name for a single sensor", () => {
    expect(ruleNameValid(["s1"], "")).toBe(true);
  });

  it("rejects an empty name for multiple sensors", () => {
    expect(ruleNameValid(["s1", "s2"], "")).toBe(false);
  });

  it("rejects a whitespace-only name for multiple sensors", () => {
    expect(ruleNameValid(["s1", "s2"], "   ")).toBe(false);
  });

  it("accepts a real name for multiple sensors", () => {
    expect(ruleNameValid(["s1", "s2"], "Hallway pair")).toBe(true);
  });
});

describe("conditionParamsValid", () => {
  it("immediate is always valid", () => {
    expect(conditionParamsValid({ type: "immediate" })).toBe(true);
  });

  it("count_in_window requires count > 0 and window_sec > 0", () => {
    expect(
      conditionParamsValid({ type: "count_in_window", count: 3, window_sec: 60 })
    ).toBe(true);
    expect(
      conditionParamsValid({ type: "count_in_window", count: 0, window_sec: 60 })
    ).toBe(false);
    expect(
      conditionParamsValid({ type: "count_in_window", count: 3, window_sec: 0 })
    ).toBe(false);
    expect(
      conditionParamsValid({ type: "count_in_window", count: 3 } as Condition)
    ).toBe(false);
    expect(
      conditionParamsValid({ type: "count_in_window", window_sec: 60 } as Condition)
    ).toBe(false);
  });

  it("entry_delay requires delay_sec > 0", () => {
    expect(conditionParamsValid({ type: "entry_delay", delay_sec: 30 })).toBe(
      true
    );
    expect(conditionParamsValid({ type: "entry_delay", delay_sec: 0 })).toBe(
      false
    );
    expect(conditionParamsValid({ type: "entry_delay" } as Condition)).toBe(
      false
    );
  });

  it("multi_sensor requires window_sec > 0", () => {
    expect(
      conditionParamsValid({ type: "multi_sensor", window_sec: 10 })
    ).toBe(true);
    expect(
      conditionParamsValid({ type: "multi_sensor", window_sec: 0 })
    ).toBe(false);
    expect(conditionParamsValid({ type: "multi_sensor" } as Condition)).toBe(
      false
    );
  });

  it("unknown condition type returns false", () => {
    expect(
      conditionParamsValid({ type: "unknown" as any })
    ).toBe(false);
  });

  it("count_in_window rejects negative values", () => {
    expect(
      conditionParamsValid({ type: "count_in_window", count: -1, window_sec: 10 })
    ).toBe(false);
    expect(
      conditionParamsValid({ type: "count_in_window", count: 2, window_sec: -5 })
    ).toBe(false);
  });

  it("entry_delay rejects negative delay", () => {
    expect(
      conditionParamsValid({ type: "entry_delay", delay_sec: -10 })
    ).toBe(false);
  });
});

describe("reconcileRulesForRemovedSensor", () => {
  const rule = (over: Partial<Rule>): Rule => ({
    id: "r",
    name: "",
    sensors: [],
    condition: { type: "immediate" },
    ...over,
  });

  it("ignores rules that do not reference the sensor", () => {
    const rules = [rule({ id: "r1", sensors: ["other"] })];
    const res = reconcileRulesForRemovedSensor(rules, "gone");
    expect(res.toDelete).toEqual([]);
    expect(res.toUpdate).toEqual([]);
  });

  it("deletes a rule whose only sensor was removed", () => {
    const rules = [rule({ id: "r1", sensors: ["gone"] })];
    const res = reconcileRulesForRemovedSensor(rules, "gone");
    expect(res.toDelete.map((r) => r.id)).toEqual(["r1"]);
    expect(res.toUpdate).toEqual([]);
  });

  it("strips the sensor from a rule that keeps others", () => {
    const rules = [
      rule({
        id: "r1",
        name: "Trio",
        sensors: ["a", "gone", "b"],
        condition: { type: "multi_sensor", window_sec: 30 },
      }),
    ];
    const res = reconcileRulesForRemovedSensor(rules, "gone");
    expect(res.toDelete).toEqual([]);
    expect(res.toUpdate[0].sensors).toEqual(["a", "b"]);
    expect(res.toUpdate[0].condition.type).toBe("multi_sensor");
  });

  it("drops the removed sensor's per-sensor count", () => {
    const rules = [
      rule({
        id: "r1",
        sensors: ["a", "gone", "b"],
        condition: {
          type: "multi_sensor",
          window_sec: 30,
          counts: { a: 2, gone: 3, b: 1 },
        },
      }),
    ];
    const res = reconcileRulesForRemovedSensor(rules, "gone");
    expect(res.toUpdate[0].condition.counts).toEqual({ a: 2, b: 1 });
  });

  it("downgrades a multi_sensor rule left with one sensor to immediate", () => {
    const rules = [
      rule({
        id: "r1",
        sensors: ["a", "gone"],
        condition: {
          type: "multi_sensor",
          window_sec: 30,
          counts: { a: 2, gone: 1 },
        },
      }),
    ];
    const res = reconcileRulesForRemovedSensor(rules, "gone");
    expect(res.toUpdate[0].sensors).toEqual(["a"]);
    expect(res.toUpdate[0].condition).toEqual({ type: "immediate" });
  });

  it("leaves a single-sensor non-multi rule's condition untouched", () => {
    const rules = [
      rule({
        id: "r1",
        sensors: ["a", "gone"],
        condition: { type: "count_in_window", count: 3, window_sec: 60 },
      }),
    ];
    const res = reconcileRulesForRemovedSensor(rules, "gone");
    expect(res.toUpdate[0].condition).toEqual({
      type: "count_in_window",
      count: 3,
      window_sec: 60,
    });
  });

  it("handles a mix of deletes and updates", () => {
    const rules = [
      rule({ id: "r1", sensors: ["gone"] }),
      rule({ id: "r2", sensors: ["gone", "b"] }),
      rule({ id: "r3", sensors: ["c"] }),
    ];
    const res = reconcileRulesForRemovedSensor(rules, "gone");
    expect(res.toDelete.map((r) => r.id)).toEqual(["r1"]);
    expect(res.toUpdate.map((r) => r.id)).toEqual(["r2"]);
  });
});

describe("ruleDisplayName", () => {
  const names = { s1: "Front door", s2: "Kitchen window" };
  const lookup = (id: string) => names[id as keyof typeof names];

  it("uses the rule's own name when it has one", () => {
    expect(ruleDisplayName({ name: "Perimeter", sensors: ["s1"] }, lookup)).toBe(
      "Perimeter"
    );
  });

  it("falls back to the sensor name for an unnamed single-sensor rule", () => {
    // buildInitialRules creates exactly this shape, so it is the common case.
    expect(ruleDisplayName({ name: "", sensors: ["s1"] }, lookup)).toBe(
      "Front door"
    );
  });

  it("treats a whitespace-only name as unnamed", () => {
    expect(ruleDisplayName({ name: "   ", sensors: ["s1"] }, lookup)).toBe(
      "Front door"
    );
  });

  it("handles a missing name field", () => {
    expect(ruleDisplayName({ sensors: ["s1"] }, lookup)).toBe("Front door");
  });

  it("joins sensor names for an unnamed multi-sensor rule", () => {
    expect(ruleDisplayName({ name: "", sensors: ["s1", "s2"] }, lookup)).toBe(
      "Front door + Kitchen window"
    );
  });

  it("falls back to the raw id when the sensor is unknown", () => {
    // An unpaired sensor still referenced by a rule must not render blank.
    expect(ruleDisplayName({ name: "", sensors: ["ghost"] }, lookup)).toBe(
      "ghost"
    );
  });

  it("returns null when there is nothing to name it with", () => {
    // Caller substitutes its own translated placeholder.
    expect(ruleDisplayName({ name: "", sensors: [] }, lookup)).toBeNull();
  });
});
