import { describe, it, expect } from "vitest";
import { Timestamp } from "firebase-admin/firestore";
import {
  zonedTimeToUtc,
  nextArmInstant,
  nextDisarmInstant,
} from "./nextOccurrence";
import { Schedule } from "./types";

const TZ = "Asia/Jerusalem"; // observes DST
const UTC = "UTC";

function schedule(over: Partial<Schedule> = {}): Schedule {
  return {
    id: "s1",
    name: "Night",
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

describe("zonedTimeToUtc", () => {
  it("resolves a winter time in Jerusalem (UTC+2)", () => {
    // 2026-01-15 23:00 IST = 21:00 UTC
    expect(zonedTimeToUtc("2026-01-15", "23:00", TZ).toISOString())
      .toBe("2026-01-15T21:00:00.000Z");
  });

  it("resolves a summer time in Jerusalem (UTC+3)", () => {
    // 2026-07-15 23:00 IDT = 20:00 UTC
    expect(zonedTimeToUtc("2026-07-15", "23:00", TZ).toISOString())
      .toBe("2026-07-15T20:00:00.000Z");
  });

  it("resolves UTC unchanged", () => {
    expect(zonedTimeToUtc("2026-01-15", "23:00", UTC).toISOString())
      .toBe("2026-01-15T23:00:00.000Z");
  });
});

describe("nextArmInstant — recurring", () => {
  it("returns today's arm time when it is still ahead", () => {
    const after = new Date("2026-01-15T10:00:00.000Z"); // 12:00 local
    const got = nextArmInstant(schedule(), TZ, after);
    expect(got?.toISOString()).toBe("2026-01-15T21:00:00.000Z");
  });

  it("rolls to tomorrow when today's time has passed", () => {
    const after = new Date("2026-01-15T22:00:00.000Z"); // 00:00 local, 16th
    const got = nextArmInstant(schedule(), TZ, after);
    expect(got?.toISOString()).toBe("2026-01-16T21:00:00.000Z");
  });

  it("honours a weekday subset (Mon-Fri) by skipping the weekend", () => {
    // 2026-01-17 is a Saturday. Next Mon-Fri arm is Monday the 19th.
    const after = new Date("2026-01-17T10:00:00.000Z");
    const got = nextArmInstant(schedule({ days: [1, 2, 3, 4, 5] }), TZ, after);
    expect(got?.toISOString()).toBe("2026-01-19T21:00:00.000Z");
  });

  it("returns null for an arm-less window", () => {
    expect(nextArmInstant(schedule({ armTime: null }), TZ, new Date())).toBeNull();
  });
});

describe("nextArmInstant — one-time", () => {
  it("returns the dated instant when it is ahead", () => {
    const s = schedule({ days: [], date: "2026-03-01" });
    const after = new Date("2026-02-28T10:00:00.000Z");
    expect(nextArmInstant(s, TZ, after)?.toISOString())
      .toBe("2026-03-01T21:00:00.000Z");
  });

  it("returns null once the dated instant has passed", () => {
    const s = schedule({ days: [], date: "2026-03-01" });
    const after = new Date("2026-03-02T10:00:00.000Z");
    expect(nextArmInstant(s, TZ, after)).toBeNull();
  });
});

describe("nextDisarmInstant", () => {
  it("computes forward from the arm instant, crossing midnight", () => {
    const armAt = new Date("2026-01-16T21:00:00.000Z"); // Fri 23:00 local
    const got = nextDisarmInstant(schedule(), TZ, armAt, armAt);
    // Saturday 07:00 local = 05:00 UTC
    expect(got?.toISOString()).toBe("2026-01-17T05:00:00.000Z");
  });

  it("uses the same day when disarm is after arm without wrapping", () => {
    const s = schedule({ armTime: "08:00", disarmTime: "17:00" });
    const armAt = new Date("2026-01-16T06:00:00.000Z"); // 08:00 local
    expect(nextDisarmInstant(s, TZ, armAt, armAt)?.toISOString())
      .toBe("2026-01-16T15:00:00.000Z");
  });

  it("resolves against days directly for an arm-less window", () => {
    const s = schedule({ armTime: null, disarmTime: "05:00" });
    const after = new Date("2026-01-15T10:00:00.000Z"); // 12:00 local
    // Today's 05:00 has passed, so tomorrow.
    expect(nextDisarmInstant(s, TZ, null, after)?.toISOString())
      .toBe("2026-01-16T03:00:00.000Z");
  });
});

describe("DST transitions", () => {
  // Israel 2026, verified against Node's ICU rather than assumed:
  //   spring forward at 2026-03-27T00:00Z — local 01:59 -> 03:00, so the
  //     whole 02:00-02:59 hour does not exist;
  //   fall back at 2026-10-24T23:00Z — local 01:59 IDT -> 01:00 IST, so the
  //     01:00-01:59 hour happens twice (note this is the 24th in UTC, but
  //     the 25th in local time).
  it("fires at the jump when the wall-clock time does not exist", () => {
    const s = schedule({ armTime: "02:30", days: [], date: "2026-03-27" });
    const after = new Date("2026-03-26T00:00:00.000Z");
    const got = nextArmInstant(s, TZ, after);
    // 02:30 is skipped; fire at the instant the clock jumps (03:00 IDT = 00:00Z)
    expect(got?.toISOString()).toBe("2026-03-27T00:00:00.000Z");
  });

  it("fires once, on the first occurrence, when the time repeats", () => {
    const s = schedule({ armTime: "01:30", days: [], date: "2026-10-25" });
    const after = new Date("2026-10-24T00:00:00.000Z");
    const got = nextArmInstant(s, TZ, after);
    // First 01:30 is IDT (UTC+3) = 22:30Z on the 24th, not the IST repeat.
    expect(got?.toISOString()).toBe("2026-10-24T22:30:00.000Z");
  });

  it("is stable in a zone without DST", () => {
    const after = new Date("2026-03-27T00:00:00.000Z");
    const got = nextArmInstant(schedule(), UTC, after);
    expect(got?.toISOString()).toBe("2026-03-27T23:00:00.000Z");
  });
});
