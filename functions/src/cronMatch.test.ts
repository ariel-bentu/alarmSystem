import { describe, it, expect } from "vitest";
import { matchField, isDue } from "./cronMatch";

describe("matchField", () => {
  it("matches everything on a wildcard", () => {
    expect(matchField("*", 0)).toBe(true);
    expect(matchField("*", 59)).toBe(true);
  });

  it("matches an exact number", () => {
    expect(matchField(17, 17)).toBe(true);
    expect(matchField(17, 18)).toBe(false);
  });

  it("matches any member of an array", () => {
    expect(matchField([0, 30], 30)).toBe(true);
    expect(matchField([0, 30], 15)).toBe(false);
  });

  it("matches 0 rather than treating it as falsy", () => {
    // Sunday is weekDay 0 and midnight is hour 0 — a truthiness check here
    // would silently never fire those.
    expect(matchField(0, 0)).toBe(true);
    expect(matchField([0], 0)).toBe(true);
  });

  it("never matches an undefined field", () => {
    expect(matchField(undefined, 5)).toBe(false);
  });
});

describe("isDue", () => {
  const at = (hour: number, minute: number, weekDay = 3) => ({
    hour,
    minute,
    weekDay,
  });

  it("fires only when all three fields match", () => {
    const spec = { min: 0, hour: 12, weekDay: "*" as const };
    expect(isDue(spec, at(12, 0))).toBe(true);
    expect(isDue(spec, at(12, 1))).toBe(false);
    expect(isDue(spec, at(13, 0))).toBe(false);
  });

  it("supports every-minute tasks", () => {
    const spec = { min: "*" as const, hour: "*" as const, weekDay: "*" as const };
    expect(isDue(spec, at(0, 0))).toBe(true);
    expect(isDue(spec, at(23, 59))).toBe(true);
  });

  it("supports twice-hourly via a minute array", () => {
    const spec = { min: [0, 30], hour: "*" as const, weekDay: "*" as const };
    expect(isDue(spec, at(4, 0))).toBe(true);
    expect(isDue(spec, at(4, 30))).toBe(true);
    expect(isDue(spec, at(4, 15))).toBe(false);
  });

  it("supports a weekly task pinned to one weekday", () => {
    const spec = { min: 0, hour: 20, weekDay: 6 };
    expect(isDue(spec, at(20, 0, 6))).toBe(true);
    expect(isDue(spec, at(20, 0, 5))).toBe(false);
  });
});
