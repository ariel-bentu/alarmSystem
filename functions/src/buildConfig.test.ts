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
  it("builds config with immediate rules", () => {
    const rules: Rule[] = [
      { id: "r1", name: "Door rule", sensors: ["s1"], condition: { type: "immediate" } },
    ];
    const config = buildRtdbConfig(rules, sensors, true, 120);

    expect(config.armed).toBe(true);
    expect(config.siren_duration_sec).toBe(120);
    expect(config.sensors["0xA1B2C3"]).toEqual({
      name: "Front door",
      enabled: true,
      conditions: [{ type: "immediate" }],
    });
    expect(Object.keys(config.sensors)).toHaveLength(1);
  });

  it("builds config with multiple sensors and conditions", () => {
    const rules: Rule[] = [
      { id: "r1", name: "Door", sensors: ["s1", "s2"], condition: { type: "immediate" } },
      { id: "r2", name: "Garage", sensors: ["s3"], condition: { type: "count_in_window", count: 3, window_sec: 60 } },
    ];
    const config = buildRtdbConfig(rules, sensors, false, 90);

    expect(config.armed).toBe(false);
    expect(config.siren_duration_sec).toBe(90);
    expect(Object.keys(config.sensors)).toHaveLength(3);
    expect(config.sensors["0xA1B2C3"]).toEqual({
      name: "Front door",
      enabled: true,
      conditions: [{ type: "immediate" }],
    });
    expect(config.sensors["0xD4E5F6"]).toEqual({
      name: "Back window",
      enabled: true,
      conditions: [{ type: "immediate" }],
    });
    expect(config.sensors["0x112233"]).toEqual({
      name: "Garage PIR",
      enabled: true,
      conditions: [{ type: "count_in_window", count: 3, window_sec: 60 }],
    });
  });

  it("merges conditions when sensor appears in multiple rules", () => {
    const rules: Rule[] = [
      { id: "r1", name: "A", sensors: ["s1"], condition: { type: "immediate" } },
      { id: "r2", name: "B", sensors: ["s1"], condition: { type: "entry_delay", delay_sec: 30 } },
    ];
    const config = buildRtdbConfig(rules, sensors, true, 60);

    expect(config.sensors["0xA1B2C3"].conditions).toHaveLength(2);
    expect(config.sensors["0xA1B2C3"].conditions[0]).toEqual({ type: "immediate" });
    expect(config.sensors["0xA1B2C3"].conditions[1]).toEqual({ type: "entry_delay", delay_sec: 30 });
  });

  it("skips sensors not found in the sensors array", () => {
    const rules: Rule[] = [
      { id: "r1", name: "Unknown", sensors: ["nonexistent"], condition: { type: "immediate" } },
    ];
    const config = buildRtdbConfig(rules, sensors, false, 120);

    expect(Object.keys(config.sensors)).toHaveLength(0);
  });

  describe("multi_sensor translation", () => {
    it("re-keys per-sensor counts by rfId", () => {
      const rules: Rule[] = [
        {
          id: "r1",
          name: "Break-in",
          sensors: ["s1", "s2"],
          condition: {
            type: "multi_sensor",
            window_sec: 60,
            counts: { s1: 1, s2: 2 },
          },
        },
      ];
      const config = buildRtdbConfig(rules, sensors, true, 120);

      // Both participating sensors carry the same rfId-keyed condition.
      for (const rfId of ["0xA1B2C3", "0xD4E5F6"]) {
        expect(config.sensors[rfId].conditions[0]).toEqual({
          type: "multi_sensor",
          window_sec: 60,
          counts: { "0xA1B2C3": 1, "0xD4E5F6": 2 },
        });
      }
    });

    it("defaults a missing count to 1 and makes every participant explicit", () => {
      const rules: Rule[] = [
        {
          id: "r1",
          name: "Pair",
          sensors: ["s1", "s3"],
          condition: {
            type: "multi_sensor",
            window_sec: 30,
            counts: { s1: 3 }, // s3 omitted
          },
        },
      ];
      const config = buildRtdbConfig(rules, sensors, true, 120);

      expect(config.sensors["0xA1B2C3"].conditions[0].counts).toEqual({
        "0xA1B2C3": 3,
        "0x112233": 1,
      });
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

      expect(config.sensors["0xA1B2C3"].conditions[0].counts).toEqual({
        "0xA1B2C3": 1,
        "0xD4E5F6": 1,
      });
    });

    it("drops participants that cannot be resolved to an rfId", () => {
      const rules: Rule[] = [
        {
          id: "r1",
          name: "Pair",
          sensors: ["s1", "ghost"],
          condition: {
            type: "multi_sensor",
            window_sec: 60,
            counts: { s1: 2, ghost: 5 },
          },
        },
      ];
      const config = buildRtdbConfig(rules, sensors, true, 120);

      expect(config.sensors["0xA1B2C3"].conditions[0].counts).toEqual({
        "0xA1B2C3": 2,
      });
      expect(Object.keys(config.sensors)).toEqual(["0xA1B2C3"]);
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

      expect(config.sensors["0xA1B2C3"].conditions[0]).toEqual({
        type: "count_in_window",
        count: 3,
        window_sec: 60,
      });
    });
  });

  it("returns empty sensors for empty rules", () => {
    const config = buildRtdbConfig([], sensors, false, 120);

    expect(config.armed).toBe(false);
    expect(config.siren_duration_sec).toBe(120);
    expect(config.sensors).toEqual({});
  });
});
