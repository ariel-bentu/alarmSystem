import { describe, it, expect } from "vitest";
import { shouldDeferToJudge } from "./judgeDefer";
import { Project, Sensor } from "./types";

function proj(overrides: Partial<Project> = {}): Project {
  return {
    id: "p1",
    name: "Home",
    ownerId: "u1",
    nvrMode: "capture+judge",
    judgeWaitSec: 45,
    ...overrides,
  } as Project;
}

function sensor(overrides: Partial<Sensor> = {}): Sensor {
  return {
    id: "s1",
    rfId: "0x009BFA",
    name: "Shed motion",
    definiteBreach: false,
    cameras: [1, 2],
    ...overrides,
  } as Sensor;
}

describe("shouldDeferToJudge", () => {
  it("defers for a non-definite sensor with cameras in capture+judge mode", () => {
    expect(shouldDeferToJudge(proj(), sensor())).toBe(true);
  });

  // The whole point of the definite tier: it wakes you NOW. Waiting for a
  // verdict would delay the alert that matters most.
  it("never defers a definite sensor", () => {
    expect(shouldDeferToJudge(proj(), sensor({ definiteBreach: true }))).toBe(false);
  });

  it("never defers a sensor whose certainty is unset (defaults definite)", () => {
    expect(
      shouldDeferToJudge(proj(), sensor({ definiteBreach: undefined }))
    ).toBe(false);
  });

  // An unresolvable cause has no sensor to read a flag from, and fails loud
  // everywhere else in this codebase.
  it("never defers when the sensor could not be resolved", () => {
    expect(shouldDeferToJudge(proj(), null)).toBe(false);
  });

  it("does not defer when judgeWaitSec is absent or 0", () => {
    expect(
      shouldDeferToJudge(proj({ judgeWaitSec: undefined }), sensor())
    ).toBe(false);
    expect(shouldDeferToJudge(proj({ judgeWaitSec: 0 }), sensor())).toBe(false);
  });

  // No verdict can ever arrive in these states, so deferring would rely
  // entirely on the sweeper and delay every alert by up to a minute.
  it("does not defer when the judge is not running", () => {
    expect(shouldDeferToJudge(proj({ nvrMode: "capture" }), sensor())).toBe(false);
    expect(shouldDeferToJudge(proj({ nvrMode: "off" }), sensor())).toBe(false);
    expect(shouldDeferToJudge(proj({ nvrMode: undefined }), sensor())).toBe(false);
  });

  it("does not defer when the sensor has no cameras ticked", () => {
    expect(shouldDeferToJudge(proj(), sensor({ cameras: [] }))).toBe(false);
    expect(shouldDeferToJudge(proj(), sensor({ cameras: undefined }))).toBe(false);
  });
});
