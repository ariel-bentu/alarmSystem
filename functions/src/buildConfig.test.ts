import { describe, it, expect } from "vitest";
import { Timestamp } from "firebase-admin/firestore";
import { buildRtdbConfig } from "./buildConfig";
import { Rule, Sensor } from "./types";

const sensors: Sensor[] = [
  { id: "s1", rfId: "0xA1B2C3", name: "Front door", pairedAt: Timestamp.fromMillis(1000), batteryStatus: "ok", lastSeen: Timestamp.fromMillis(2000) },
  { id: "s2", rfId: "0xD4E5F6", name: "Back window", pairedAt: Timestamp.fromMillis(1000), batteryStatus: "low", lastSeen: Timestamp.fromMillis(3000) },
  { id: "s3", rfId: "0x112233", name: "Garage PIR", pairedAt: Timestamp.fromMillis(1000), batteryStatus: "ok", lastSeen: null },
];

describe("buildRtdbConfig", () => {
  it("builds config with an immediate rule", () => {
    const rules: Rule[] = [
      { id: "r1", name: "Door rule", sensors: ["s1"], condition: { type: "immediate" } },
    ];
    const config = buildRtdbConfig(rules, sensors, true, 120);

    expect(config.a).toBe(true);
    expect(config.d).toBe(120);
    expect(config.r).toEqual(["0xA1B2C3"]);
    expect(config.c).toEqual([[{ t: 0 }]]);
  });

  it("builds config with multiple sensors and conditions, index-aligned", () => {
    const rules: Rule[] = [
      { id: "r1", name: "Door", sensors: ["s1", "s2"], condition: { type: "immediate" } },
      { id: "r2", name: "Garage", sensors: ["s3"], condition: { type: "count_in_window", count: 3, window_sec: 60 } },
    ];
    const config = buildRtdbConfig(rules, sensors, false, 90);

    expect(config.a).toBe(false);
    expect(config.d).toBe(90);
    expect(config.r).toEqual(["0xA1B2C3", "0xD4E5F6", "0x112233"]);
    expect(config.c).toEqual([
      [{ t: 0 }],
      [{ t: 0 }],
      [{ t: 1, n: 3, w: 60 }],
    ]);
  });

  it("merges conditions when a sensor appears in multiple rules", () => {
    const rules: Rule[] = [
      { id: "r1", name: "A", sensors: ["s1"], condition: { type: "immediate" } },
      { id: "r2", name: "B", sensors: ["s1"], condition: { type: "entry_delay", delay_sec: 30 } },
    ];
    const config = buildRtdbConfig(rules, sensors, true, 60);

    expect(config.r).toEqual(["0xA1B2C3"]);
    expect(config.c).toEqual([[{ t: 0 }, { t: 2, y: 30 }]]);
  });

  it("skips sensors not found in the sensors array", () => {
    const rules: Rule[] = [
      { id: "r1", name: "Unknown", sensors: ["nonexistent"], condition: { type: "immediate" } },
    ];
    const config = buildRtdbConfig(rules, sensors, false, 120);

    expect(config.r).toEqual([]);
    expect(config.c).toEqual([]);
  });

  describe("multi_sensor translation", () => {
    it("re-keys per-sensor counts by index into r", () => {
      const rules: Rule[] = [
        {
          id: "r1",
          name: "Break-in",
          sensors: ["s1", "s2"],
          condition: { type: "multi_sensor", window_sec: 60, counts: { s1: 1, s2: 2 } },
        },
      ];
      const config = buildRtdbConfig(rules, sensors, true, 120);

      expect(config.r).toEqual(["0xA1B2C3", "0xD4E5F6"]);
      // index 0 = s1/0xA1B2C3, index 1 = s2/0xD4E5F6
      expect(config.c).toEqual([
        [{ t: 3, w: 60, k: { "0": 1, "1": 2 } }],
        [{ t: 3, w: 60, k: { "0": 1, "1": 2 } }],
      ]);
    });

    it("defaults a missing count to 1 and makes every participant explicit", () => {
      const rules: Rule[] = [
        {
          id: "r1",
          name: "Pair",
          sensors: ["s1", "s3"],
          condition: { type: "multi_sensor", window_sec: 30, counts: { s1: 3 } }, // s3 omitted
        },
      ];
      const config = buildRtdbConfig(rules, sensors, true, 120);

      expect(config.r).toEqual(["0xA1B2C3", "0x112233"]);
      expect(config.c[0][0]).toEqual({ t: 3, w: 30, k: { "0": 3, "1": 1 } });
    });

    it("fills in counts when the condition has none at all", () => {
      const rules: Rule[] = [
        {
          id: "r1",
          name: "Pair",
          sensors: ["s1", "s2"],
          condition: { type: "multi_sensor", window_sec: 45 },
        },
      ];
      const config = buildRtdbConfig(rules, sensors, true, 120);

      expect(config.c[0][0]).toEqual({ t: 3, w: 45, k: { "0": 1, "1": 1 } });
    });

    it("drops participants that cannot be resolved to an rfId", () => {
      const rules: Rule[] = [
        {
          id: "r1",
          name: "Pair",
          sensors: ["s1", "ghost"],
          condition: { type: "multi_sensor", window_sec: 60, counts: { s1: 2, ghost: 5 } },
        },
      ];
      const config = buildRtdbConfig(rules, sensors, true, 120);

      expect(config.r).toEqual(["0xA1B2C3"]);
      expect(config.c).toEqual([[{ t: 3, w: 60, k: { "0": 2 } }]]);
    });

    it("leaves single-sensor conditions untouched", () => {
      const rules: Rule[] = [
        {
          id: "r1",
          name: "Door",
          sensors: ["s1"],
          condition: { type: "count_in_window", count: 3, window_sec: 60 },
        },
      ];
      const config = buildRtdbConfig(rules, sensors, true, 120);

      expect(config.c).toEqual([[{ t: 1, n: 3, w: 60 }]]);
    });
  });

  it("returns empty r/c for empty rules", () => {
    const config = buildRtdbConfig([], sensors, false, 120);

    expect(config.a).toBe(false);
    expect(config.d).toBe(120);
    expect(config.r).toEqual([]);
    expect(config.c).toEqual([]);
  });
});

describe("buildRtdbConfig — always-on rules", () => {
  it("omits x for an ordinary rule", () => {
    const rules: Rule[] = [
      { id: "r1", name: "Door", sensors: ["s1"], condition: { type: "immediate" } },
    ];
    const config = buildRtdbConfig(rules, sensors, true, 120);
    expect(config.c).toEqual([[{ t: 0 }]]);
  });

  it("sets x:1 for an always rule", () => {
    const rules: Rule[] = [
      {
        id: "r1",
        name: "Smoke",
        sensors: ["s1"],
        condition: { type: "immediate" },
        always: true,
      },
    ];
    const config = buildRtdbConfig(rules, sensors, true, 120);
    expect(config.c).toEqual([[{ t: 0, x: 1 }]]);
  });

  it("includes an always rule from a non-active profile", () => {
    // The active profile covers s1; the always rule lives elsewhere and
    // covers s2. Without the second pass, s2 never reaches the device.
    const active: Rule[] = [
      { id: "r1", name: "Door", sensors: ["s1"], condition: { type: "immediate" } },
    ];
    const alwaysRules: Rule[] = [
      {
        id: "r9",
        name: "Smoke",
        sensors: ["s2"],
        condition: { type: "immediate" },
        always: true,
      },
    ];
    const config = buildRtdbConfig(active, sensors, true, 120, true, alwaysRules);
    expect(config.r).toEqual(["0xA1B2C3", "0xD4E5F6"]);
    expect(config.c).toEqual([[{ t: 0 }], [{ t: 0, x: 1 }]]);
  });

  it("does not duplicate an always rule that is also in the active profile", () => {
    const rule: Rule = {
      id: "r1",
      name: "Smoke",
      sensors: ["s1"],
      condition: { type: "immediate" },
      always: true,
    };
    // Same rule id arriving through both paths must appear once.
    const config = buildRtdbConfig([rule], sensors, true, 120, true, [rule]);
    expect(config.r).toEqual(["0xA1B2C3"]);
    expect(config.c).toEqual([[{ t: 0, x: 1 }]]);
  });
});
