import { describe, it, expect } from "vitest";
import { rangeCutoff } from "./timeRange";
import type { TimeRange } from "@/types";

const MS_PER_DAY = 86_400_000;
const NOW = 1_700_000_000_000; // fixed reference point

describe("rangeCutoff", () => {
  it("returns now - 1 day for 'day'", () => {
    expect(rangeCutoff("day", NOW)).toBe(NOW - MS_PER_DAY);
  });

  it("returns now - 7 days for 'week'", () => {
    expect(rangeCutoff("week", NOW)).toBe(NOW - 7 * MS_PER_DAY);
  });

  it("returns now - 30 days for 'month'", () => {
    expect(rangeCutoff("month", NOW)).toBe(NOW - 30 * MS_PER_DAY);
  });

  it("returns now - 90 days for '3months'", () => {
    expect(rangeCutoff("3months", NOW)).toBe(NOW - 90 * MS_PER_DAY);
  });

  it("returns now - 365 days for 'year'", () => {
    expect(rangeCutoff("year", NOW)).toBe(NOW - 365 * MS_PER_DAY);
  });

  it("result is always less than now", () => {
    const ranges: TimeRange[] = ["day", "week", "month", "3months", "year"];
    for (const r of ranges) {
      expect(rangeCutoff(r, NOW)).toBeLessThan(NOW);
    }
  });

  it("ordering: day > week > month > 3months > year (cutoffs decrease)", () => {
    expect(rangeCutoff("day", NOW)).toBeGreaterThan(rangeCutoff("week", NOW));
    expect(rangeCutoff("week", NOW)).toBeGreaterThan(rangeCutoff("month", NOW));
    expect(rangeCutoff("month", NOW)).toBeGreaterThan(rangeCutoff("3months", NOW));
    expect(rangeCutoff("3months", NOW)).toBeGreaterThan(rangeCutoff("year", NOW));
  });

  it("works with zero as now", () => {
    expect(rangeCutoff("day", 0)).toBe(-MS_PER_DAY);
  });
});
