import { describe, it, expect } from "vitest";
import { Timestamp } from "firebase/firestore";
import { overlaps, findOverlaps } from "./scheduleOverlap";
import type { Schedule } from "@/types";

function s(over: Partial<Schedule> = {}): Schedule {
  return {
    id: "a",
    name: "n",
    enabled: true,
    side: "device",
    profileId: "away",
    armTime: "23:00",
    disarmTime: "07:00",
    days: [0, 1, 2, 3, 4, 5, 6],
    date: null,
    nextArmAt: null,
    nextDisarmAt: null,
    lastFiredAt: null,
    createdAt: Timestamp.fromMillis(0),
    ...over,
  };
}

describe("overlaps", () => {
  it("detects two windows sharing a day and side", () => {
    expect(
      overlaps(s({ id: "a" }), s({ id: "b", armTime: "22:00", disarmTime: "06:00" }))
    ).toBe(true);
  });

  it("ignores schedules on different sides", () => {
    expect(overlaps(s({ id: "a" }), s({ id: "b", side: "server" }))).toBe(false);
  });

  it("ignores schedules with no day in common", () => {
    const a = s({ id: "a", days: [1, 2] });
    const b = s({ id: "b", days: [5, 6] });
    expect(overlaps(a, b)).toBe(false);
  });

  it("treats a midnight-crossing window as covering the early hours", () => {
    // 23:00->07:00 overlaps a 06:00->08:00 window on the same day.
    const night = s({ id: "a" });
    const morning = s({ id: "b", armTime: "06:00", disarmTime: "08:00" });
    expect(overlaps(night, morning)).toBe(true);
  });

  it("finds no overlap between disjoint same-day windows", () => {
    const a = s({ id: "a", armTime: "08:00", disarmTime: "12:00" });
    const b = s({ id: "b", armTime: "13:00", disarmTime: "17:00" });
    expect(overlaps(a, b)).toBe(false);
  });

  it("never reports a schedule as overlapping itself", () => {
    const a = s({ id: "a" });
    expect(findOverlaps(a, [a])).toEqual([]);
  });

  it("ignores disabled schedules", () => {
    const a = s({ id: "a" });
    const b = s({ id: "b", enabled: false });
    expect(findOverlaps(a, [b])).toEqual([]);
  });
});
