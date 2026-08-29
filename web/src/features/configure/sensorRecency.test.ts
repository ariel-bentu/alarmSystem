import { describe, it, expect } from "vitest";
import {
  JUST_SEEN_MS,
  effectiveLastSeen,
  isJustSeen,
  sortByLastSeenDesc,
} from "./sensorRecency";

describe("effectiveLastSeen", () => {
  const timing = {
    "0xA1B2C3": { firstSeen: 1000, lastSeen: 5000, count: 3 },
  };

  it("returns the RTDB timestamp when it is newer than Firestore", () => {
    expect(effectiveLastSeen("0xA1B2C3", timing, 4000)).toBe(5000);
  });

  it("returns the Firestore timestamp when it is newer than RTDB", () => {
    expect(effectiveLastSeen("0xA1B2C3", timing, 9000)).toBe(9000);
  });

  it("returns the RTDB timestamp when there is no Firestore value", () => {
    expect(effectiveLastSeen("0xA1B2C3", timing, null)).toBe(5000);
  });

  it("returns the Firestore timestamp when the rfId has no RTDB events", () => {
    expect(effectiveLastSeen("0xUNKNOWN", timing, 7000)).toBe(7000);
  });

  it("returns null when neither source has seen the sensor", () => {
    expect(effectiveLastSeen("0xUNKNOWN", timing, null)).toBeNull();
  });

  it("returns null for an empty timing map and no Firestore value", () => {
    expect(effectiveLastSeen("0xA1B2C3", {}, null)).toBeNull();
  });
});

describe("isJustSeen", () => {
  const now = 1_000_000;

  it("is true for an event that just arrived", () => {
    expect(isJustSeen(now, now)).toBe(true);
  });

  it("is true just inside the window", () => {
    expect(isJustSeen(now - JUST_SEEN_MS + 1, now)).toBe(true);
  });

  it("is true exactly at the window boundary", () => {
    expect(isJustSeen(now - JUST_SEEN_MS, now)).toBe(true);
  });

  it("is false just outside the window", () => {
    expect(isJustSeen(now - JUST_SEEN_MS - 1, now)).toBe(false);
  });

  it("is false for a sensor never seen", () => {
    expect(isJustSeen(null, now)).toBe(false);
  });
});

describe("sortByLastSeenDesc", () => {
  it("orders most recently seen first", () => {
    const items = [
      { id: "a", seen: 100 },
      { id: "b", seen: 300 },
      { id: "c", seen: 200 },
    ];
    expect(sortByLastSeenDesc(items, (i) => i.seen).map((i) => i.id)).toEqual([
      "b",
      "c",
      "a",
    ]);
  });

  it("sinks never-seen items to the bottom", () => {
    const items = [
      { id: "a", seen: null },
      { id: "b", seen: 300 },
      { id: "c", seen: null },
      { id: "d", seen: 100 },
    ];
    expect(sortByLastSeenDesc(items, (i) => i.seen).map((i) => i.id)).toEqual([
      "b",
      "d",
      "a",
      "c",
    ]);
  });

  it("keeps the original relative order of never-seen items", () => {
    const items = [
      { id: "x", seen: null },
      { id: "y", seen: null },
    ];
    expect(sortByLastSeenDesc(items, (i) => i.seen).map((i) => i.id)).toEqual([
      "x",
      "y",
    ]);
  });

  it("does not mutate the input array", () => {
    const items = [
      { id: "a", seen: 100 },
      { id: "b", seen: 300 },
    ];
    sortByLastSeenDesc(items, (i) => i.seen);
    expect(items.map((i) => i.id)).toEqual(["a", "b"]);
  });

  it("handles an empty list", () => {
    expect(sortByLastSeenDesc([], () => null)).toEqual([]);
  });
});
