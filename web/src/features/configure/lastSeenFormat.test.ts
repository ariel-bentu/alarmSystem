import { describe, it, expect } from "vitest";
import { formatRelative, timeOfDay } from "./lastSeenFormat";

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
});
