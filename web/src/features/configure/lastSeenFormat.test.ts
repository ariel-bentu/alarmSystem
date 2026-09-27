import { describe, it, expect } from "vitest";
import {
  formatRelative,
  relativeSuffix,
  timeOfDay,
  timeOfDaySeconds,
} from "./lastSeenFormat";

// Fixed reference: Wednesday 2026-08-27, 14:23 local.
const NOW = new Date(2026, 7, 27, 14, 23, 0).getTime();
const MIN = 60_000;
const HOUR = 60 * MIN;

const en = (k: string, vars?: Record<string, string | number>) =>
  vars ? `${k}:${JSON.stringify(vars)}` : k;

describe("formatRelative", () => {
  it("says 'just now' under a minute", () => {
    expect(formatRelative(NOW - 30_000, NOW, en)).toBe("time.justNow");
  });

  it("uses the singular minute key at exactly one minute", () => {
    expect(formatRelative(NOW - MIN, NOW, en)).toBe("time.minuteAgo");
  });

  it("uses the plural minute key with a count", () => {
    expect(formatRelative(NOW - 5 * MIN, NOW, en)).toBe(
      'time.minutesAgo:{"count":5}'
    );
  });

  it("uses the singular hour key at exactly one hour", () => {
    expect(formatRelative(NOW - HOUR, NOW, en)).toBe("time.hourAgo");
  });

  it("uses the plural hour key with a count", () => {
    expect(formatRelative(NOW - 3 * HOUR, NOW, en)).toBe(
      'time.hoursAgo:{"count":3}'
    );
  });

  it("falls back to a clock time once past the relative window", () => {
    // 25h ago is yesterday — relative phrasing stops being useful.
    const out = formatRelative(NOW - 25 * HOUR, NOW, en);
    expect(out).not.toContain("time.");
  });

  it("never returns a negative count for a future timestamp (clock skew)", () => {
    expect(formatRelative(NOW + 5 * MIN, NOW, en)).toBe("time.justNow");
  });
});

describe("relativeSuffix", () => {
  it("gives the relative phrasing inside the window", () => {
    expect(relativeSuffix(NOW - 5 * MIN, NOW, en)).toBe(
      'time.minutesAgo:{"count":5}'
    );
  });

  // The caller already prints the exact clock time, so a date-and-time
  // fallback would just repeat what it sits next to.
  it("returns null past the window instead of a date string", () => {
    expect(relativeSuffix(NOW - 25 * HOUR, NOW, en)).toBeNull();
  });

  it("returns null exactly at the 24h boundary", () => {
    expect(relativeSuffix(NOW - 24 * HOUR, NOW, en)).toBeNull();
  });
});

describe("timeOfDay", () => {
  it("formats hours and minutes", () => {
    const out = timeOfDay(new Date(2026, 7, 27, 10, 23).getTime());
    expect(out).toMatch(/10/);
    expect(out).toMatch(/23/);
  });

  // The browser locale is often en-US even for a Hebrew speaker, which would
  // render "05:29 PM" where these tables want "17:29".
  it("uses 24-hour time regardless of locale, never AM/PM", () => {
    const out = timeOfDay(new Date(2026, 7, 27, 17, 29).getTime());
    expect(out).toMatch(/17/);
    expect(out).not.toMatch(/[AP]M/i);
  });

  it("omits seconds — the sensor tables do not need them", () => {
    const out = timeOfDay(new Date(2026, 7, 27, 10, 23, 45).getTime());
    expect(out).not.toMatch(/45/);
  });
});

describe("timeOfDaySeconds", () => {
  // Seconds are the point: rules like count_in_window are planned by reading
  // how far apart two triggers actually landed.
  it("includes seconds", () => {
    const out = timeOfDaySeconds(new Date(2026, 7, 27, 10, 23, 45).getTime());
    expect(out).toMatch(/10.23.45/);
  });

  it("zero-pads all three fields", () => {
    const out = timeOfDaySeconds(new Date(2026, 7, 27, 9, 5, 3).getTime());
    expect(out).toMatch(/09.05.03/);
  });

  it("uses 24-hour time regardless of locale, never AM/PM", () => {
    const out = timeOfDaySeconds(new Date(2026, 7, 27, 17, 29, 8).getTime());
    expect(out).toMatch(/17/);
    expect(out).not.toMatch(/[AP]M/i);
  });
});
