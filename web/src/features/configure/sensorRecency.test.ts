import { describe, it, expect } from "vitest";
import {
  JUST_SEEN_MS,
  effectiveLastSeen,
  familyLastSeen,
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

describe("familyLastSeen", () => {
  const timing = (lastSeen: number) => ({ firstSeen: 0, lastSeen, count: 1 });

  it("counts every code in the family, not just the paired one", () => {
    // A PIR paired on 0x0061DA that was tampered (0x0061DB) five minutes ago
    // used to read as silent, because RTDB keys events by the FULL code and
    // the lookup was an exact match.
    const events = { "0x0061DA": timing(100), "0x0061DB": timing(900) };
    expect(familyLastSeen("0x0061D", events, null).lastSeen).toBe(900);
  });

  it("names the most recent event type in the family", () => {
    const events = { "0x0061DA": timing(100), "0x0061DB": timing(900) };
    expect(familyLastSeen("0x0061D", events, null).lastEvent).toBe("tamper");
  });

  it("ignores codes from other families", () => {
    const events = { "0x0061DA": timing(100), "0x2E5B79": timing(900) };
    const result = familyLastSeen("0x0061D", events, null);
    expect(result.lastSeen).toBe(100);
    expect(result.lastEvent).toBe("trigger");
  });

  it("falls back to the Firestore value when RTDB has nothing", () => {
    // RTDB events are cleaned up on a retention schedule; Firestore's
    // lastSeen survives that, so history is not lost.
    const result = familyLastSeen("0x0061D", {}, 500);
    expect(result.lastSeen).toBe(500);
    expect(result.lastEvent).toBeNull();
  });

  it("takes the newer of RTDB and Firestore", () => {
    const events = { "0x0061DA": timing(100) };
    expect(familyLastSeen("0x0061D", events, 500).lastSeen).toBe(500);
    expect(familyLastSeen("0x0061D", events, 50).lastSeen).toBe(100);
  });

  it("returns nulls for a sensor never seen anywhere", () => {
    expect(familyLastSeen("0x0061D", {}, null)).toEqual({
      lastSeen: null,
      lastEvent: null,
    });
  });

  it("returns the Firestore value when the family cannot be derived", () => {
    const events = { "0x0061DA": timing(100) };
    expect(familyLastSeen(null, events, 500).lastSeen).toBe(500);
  });

  it("skips non-hex RTDB keys without throwing", () => {
    // /events also holds "SIREN0" and "REMOTE" keys.
    const events = { SIREN0: timing(900), "0x0061DA": timing(100) };
    expect(familyLastSeen("0x0061D", events, null).lastSeen).toBe(100);
  });
});
