import { describe, it, expect } from "vitest";
import {
  CAUSE_MAX_AGE_MS,
  AlarmCause,
  isCauseFresh,
  resolveCauseLabel,
  parseCause,
} from "./alarmCause";
import { Rule } from "./types";

describe("isCauseFresh", () => {
  const now = 1_000_000;

  it("accepts a cause written just now", () => {
    expect(isCauseFresh({ at: now }, now)).toBe(true);
  });

  it("accepts a cause just inside the window", () => {
    expect(isCauseFresh({ at: now - CAUSE_MAX_AGE_MS + 1 }, now)).toBe(true);
  });

  it("accepts a cause exactly at the window boundary", () => {
    expect(isCauseFresh({ at: now - CAUSE_MAX_AGE_MS }, now)).toBe(true);
  });

  it("rejects a stale cause left over from an earlier alarm", () => {
    expect(isCauseFresh({ at: now - CAUSE_MAX_AGE_MS - 1 }, now)).toBe(false);
  });

  it("rejects a cause with no timestamp", () => {
    expect(isCauseFresh({ at: undefined }, now)).toBe(false);
  });

  it("rejects a null cause", () => {
    expect(isCauseFresh(null, now)).toBe(false);
  });

  it("tolerates a cause timestamped slightly in the future (clock skew)", () => {
    expect(isCauseFresh({ at: now + 5_000 }, now)).toBe(true);
  });
});

describe("parseCause", () => {
  it("parses a server-written cause carrying a label", () => {
    expect(parseCause({ label: "Night watch", at: 123 })).toEqual({
      label: "Night watch",
      at: 123,
    });
  });

  it("parses a device-written cause carrying rfId and condition type", () => {
    expect(parseCause({ rfId: "0xA1B2C3", ct: 0, at: 123 })).toEqual({
      rfId: "0xA1B2C3",
      ct: 0,
      at: 123,
    });
  });

  it("returns null for a non-object value", () => {
    expect(parseCause("boom")).toBeNull();
    expect(parseCause(42)).toBeNull();
    expect(parseCause(null)).toBeNull();
    expect(parseCause(undefined)).toBeNull();
  });

  it("ignores unexpected field types rather than throwing", () => {
    expect(parseCause({ label: 7, at: "soon" })).toEqual({});
  });
});

describe("resolveCauseLabel", () => {
  const rules: Rule[] = [
    {
      id: "r1",
      name: "Night watch",
      sensors: ["s1"],
      condition: { type: "immediate" },
    },
    {
      id: "r2",
      name: "",
      sensors: ["s2"],
      condition: { type: "immediate" },
    },
  ];
  const sensorNamesByRfId = { "0xA1B2C3": "Front door", "0xD4E5F6": "Hallway PIR" };
  const sensorIdsByRfId = { "0xA1B2C3": "s1", "0xD4E5F6": "s2" };

  it("uses a server-written label verbatim", () => {
    const cause: AlarmCause = { label: "Perimeter", at: 1 };
    expect(resolveCauseLabel(cause, rules, sensorNamesByRfId, sensorIdsByRfId)).toBe(
      "Perimeter"
    );
  });

  it("resolves a device cause to the matching rule name", () => {
    const cause: AlarmCause = { rfId: "0xA1B2C3", at: 1 };
    expect(resolveCauseLabel(cause, rules, sensorNamesByRfId, sensorIdsByRfId)).toBe(
      "Night watch"
    );
  });

  it("falls back to the sensor name when the matching rule is unnamed", () => {
    const cause: AlarmCause = { rfId: "0xD4E5F6", at: 1 };
    expect(resolveCauseLabel(cause, rules, sensorNamesByRfId, sensorIdsByRfId)).toBe(
      "Hallway PIR"
    );
  });

  it("falls back to the sensor name when no rule covers the sensor", () => {
    const cause: AlarmCause = { rfId: "0xA1B2C3", at: 1 };
    expect(resolveCauseLabel(cause, [], sensorNamesByRfId, sensorIdsByRfId)).toBe(
      "Front door"
    );
  });

  it("falls back to the raw rfId when the sensor is unknown", () => {
    const cause: AlarmCause = { rfId: "0xFFFFFF", at: 1 };
    expect(resolveCauseLabel(cause, rules, sensorNamesByRfId, sensorIdsByRfId)).toBe(
      "0xFFFFFF"
    );
  });

  it("prefers an explicit label over rfId resolution", () => {
    const cause: AlarmCause = { label: "Explicit", rfId: "0xA1B2C3", at: 1 };
    expect(resolveCauseLabel(cause, rules, sensorNamesByRfId, sensorIdsByRfId)).toBe(
      "Explicit"
    );
  });

  it("returns null when the cause carries neither label nor rfId", () => {
    expect(resolveCauseLabel({ at: 1 }, rules, sensorNamesByRfId, sensorIdsByRfId)).toBeNull();
  });

  it("ignores a blank label and falls through to rfId", () => {
    const cause: AlarmCause = { label: "   ", rfId: "0xA1B2C3", at: 1 };
    expect(resolveCauseLabel(cause, rules, sensorNamesByRfId, sensorIdsByRfId)).toBe(
      "Night watch"
    );
  });
});
