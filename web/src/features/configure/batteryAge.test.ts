// Pure battery-age logic. Extracted from SensorsTab so the date handling can
// be pinned without mounting the tab (which needs Firestore and auth context).
//
// The date-conversion tests are the point of this file: an <input type="date">
// speaks "yyyy-mm-dd" with no timezone, and the obvious conversions both go
// wrong by a day in Asia/Jerusalem.
import { describe, it, expect } from "vitest";
import { Timestamp } from "firebase/firestore";
import {
  DEFAULT_BATTERY_ALERT_MONTHS,
  batteryStartedAt,
  batteryAgeMonths,
  formatBatteryAge,
  isBatteryStale,
  toDateInputValue,
  fromDateInputValue,
} from "./batteryAge";

const ts = (ms: number) => Timestamp.fromMillis(ms);
const DAY = 24 * 60 * 60 * 1000;

describe("batteryStartedAt", () => {
  it("prefers the recorded replacement date", () => {
    const sensor = { batteryChangedAt: ts(5000), pairedAt: ts(1000) };
    expect(batteryStartedAt(sensor)).toBe(5000);
  });

  it("falls back to pairedAt when no replacement is recorded", () => {
    // The battery was presumably fresh when the sensor was paired, so this is
    // a defensible lower bound on its age. It is what makes every sensor
    // covered with nothing to remember — the sensors nobody got round to
    // recording are exactly the ones likely to hold a dying battery.
    expect(batteryStartedAt({ batteryChangedAt: null, pairedAt: ts(1000) })).toBe(
      1000
    );
    expect(batteryStartedAt({ pairedAt: ts(1000) })).toBe(1000);
  });

  it("returns null when even pairedAt is missing", () => {
    // Should not happen (pairedAt is written on create), but treating a
    // missing date as epoch 0 would make the sensor look 56 years old and
    // fire a bogus alert on the next noon run.
    expect(
      batteryStartedAt({ pairedAt: null as unknown as Timestamp })
    ).toBeNull();
    expect(batteryStartedAt({})).toBeNull();
  });
});

describe("batteryAgeMonths", () => {
  it("is zero for a battery changed today", () => {
    const now = Date.parse("2026-09-23T12:00:00Z");
    expect(batteryAgeMonths(now, now)).toBe(0);
  });

  it("counts whole months only", () => {
    const start = Date.parse("2026-01-15T00:00:00Z");
    // 30 days later is not yet two months.
    expect(batteryAgeMonths(start, Date.parse("2026-02-14T00:00:00Z"))).toBe(0);
    expect(batteryAgeMonths(start, Date.parse("2026-02-15T00:00:00Z"))).toBe(1);
    expect(batteryAgeMonths(start, Date.parse("2026-03-15T00:00:00Z"))).toBe(2);
  });

  it("counts across a year boundary", () => {
    expect(
      batteryAgeMonths(
        Date.parse("2025-11-15T00:00:00Z"),
        Date.parse("2026-09-15T00:00:00Z")
      )
    ).toBe(10);
  });

  it("never returns a negative age", () => {
    // A future start date is a typo, not a negative-age battery.
    expect(
      batteryAgeMonths(
        Date.parse("2027-01-01T00:00:00Z"),
        Date.parse("2026-09-23T00:00:00Z")
      )
    ).toBe(0);
  });
});

describe("isBatteryStale", () => {
  const start = Date.parse("2025-09-23T00:00:00Z");
  const now = Date.parse("2026-09-23T00:00:00Z"); // exactly 12 months later

  it("is stale at exactly the threshold", () => {
    expect(isBatteryStale(start, now, 12)).toBe(true);
  });

  it("is not stale just under the threshold", () => {
    expect(isBatteryStale(start, now, 13)).toBe(false);
  });

  it("is never stale when the threshold is zero or negative", () => {
    // Zero/negative is the project-wide "off" switch.
    expect(isBatteryStale(start, now, 0)).toBe(false);
    expect(isBatteryStale(start, now, -1)).toBe(false);
  });

  it("is not stale when the start date is unknown", () => {
    expect(isBatteryStale(null, now, 12)).toBe(false);
  });
});

describe("toDateInputValue / fromDateInputValue", () => {
  it("renders a local calendar date, not a UTC one", () => {
    // 2026-09-23 22:00 UTC is already the 24th in Asia/Jerusalem. The input
    // must show the local day, because that is the day the user means.
    // Built from local parts so this passes in CI (UTC) as well as in
    // Jerusalem.
    const d = new Date(2026, 8, 23, 22, 0, 0); // local 2026-09-23 22:00
    expect(toDateInputValue(d.getTime())).toBe("2026-09-23");
  });

  it("zero-pads month and day", () => {
    const d = new Date(2026, 0, 5); // local 2026-01-05
    expect(toDateInputValue(d.getTime())).toBe("2026-01-05");
  });

  it("parses to LOCAL midnight, not UTC midnight", () => {
    // The bug this guards: Date.parse("2026-09-23") is UTC midnight, which is
    // the 22nd at 21:00 in a UTC+3 zone. Round-tripping it would move the day.
    const ms = fromDateInputValue(
      "2026-09-23",
      Date.parse("2027-01-01T00:00:00Z")
    );
    expect(ms).not.toBeNull();
    const d = new Date(ms as number);
    expect(d.getFullYear()).toBe(2026);
    expect(d.getMonth()).toBe(8); // September
    expect(d.getDate()).toBe(23);
    expect(d.getHours()).toBe(0);
    expect(d.getMinutes()).toBe(0);
  });

  it("round-trips any date back to the same string", () => {
    const later = Date.parse("2030-01-01T00:00:00Z");
    for (const s of ["2026-09-23", "2026-01-01", "2025-12-31", "2024-02-29"]) {
      const ms = fromDateInputValue(s, later);
      expect(ms).not.toBeNull();
      expect(toDateInputValue(ms as number)).toBe(s);
    }
  });

  it("rejects a future date", () => {
    // A replacement date in the future is a typo. The input also carries
    // max={today}, but a typed date bypasses that on some browsers.
    const now = Date.parse("2026-09-23T12:00:00Z");
    expect(fromDateInputValue("2026-09-24", now)).toBeNull();
  });

  it("accepts today", () => {
    // The Today button's case: same calendar day must not count as future.
    const now = new Date(2026, 8, 23, 15, 30).getTime();
    expect(fromDateInputValue("2026-09-23", now)).not.toBeNull();
  });

  it("rejects an empty or malformed value", () => {
    const now = Date.parse("2026-09-23T12:00:00Z");
    expect(fromDateInputValue("", now)).toBeNull();
    expect(fromDateInputValue("not-a-date", now)).toBeNull();
    expect(fromDateInputValue("2026-13-45", now)).toBeNull();
  });

  it("rejects a date that does not exist", () => {
    // new Date(2026, 1, 30) rolls over to March 2nd rather than failing, so
    // without an explicit check a typo would be stored as a different date.
    const now = Date.parse("2027-01-01T00:00:00Z");
    expect(fromDateInputValue("2026-02-30", now)).toBeNull();
    expect(fromDateInputValue("2025-02-29", now)).toBeNull(); // not a leap year
  });
});

describe("formatBatteryAge", () => {
  // The real t() is typed against en.ts's key union; this stub returns the key
  // plus its vars so the tests assert on which key was chosen, not on English.
  const t = ((key: string, vars?: Record<string, string | number>) =>
    vars ? `${key}:${JSON.stringify(vars)}` : key) as unknown as Parameters<
    typeof formatBatteryAge
  >[2];

  it("says today for a battery changed today", () => {
    const now = new Date(2026, 8, 23, 18, 0).getTime();
    const start = new Date(2026, 8, 23, 9, 0).getTime();
    expect(formatBatteryAge(start, now, t)).toBe("cfg.sensors.batteryToday");
  });

  it("counts days under a month", () => {
    const now = Date.parse("2026-09-23T00:00:00Z");
    expect(formatBatteryAge(now - 3 * DAY, now, t)).toBe(
      'cfg.sensors.batteryDaysAgo:{"count":3}'
    );
  });

  it("counts months at a month and over", () => {
    expect(
      formatBatteryAge(
        Date.parse("2025-10-23T00:00:00Z"),
        Date.parse("2026-09-23T00:00:00Z"),
        t
      )
    ).toBe('cfg.sensors.batteryMonthsAgo:{"count":11}');
  });

  it("returns null when the start date is unknown", () => {
    // The caller renders a muted "not recorded" rather than a fake age.
    expect(formatBatteryAge(null, Date.now(), t)).toBeNull();
  });
});

describe("DEFAULT_BATTERY_ALERT_MONTHS", () => {
  it("is a year", () => {
    expect(DEFAULT_BATTERY_ALERT_MONTHS).toBe(12);
  });
});
