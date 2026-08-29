import { describe, it, expect } from "vitest";
import { groupItemsByDay } from "./groupSensorsByDay";

// Fixed reference: Thursday 2026-08-27, 14:23 local.
const NOW = new Date(2026, 7, 27, 14, 23, 0).getTime();
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

const at = (ts: number | null, id: string) => ({ id, seen: ts });
const seenOf = (x: { seen: number | null }) => x.seen;

describe("groupItemsByDay", () => {
  it("returns nothing for an empty list", () => {
    expect(groupItemsByDay([], seenOf, NOW)).toEqual([]);
  });

  it("puts one item in one group", () => {
    const groups = groupItemsByDay([at(NOW - 5 * MIN, "a")], seenOf, NOW);
    expect(groups).toHaveLength(1);
    expect(groups[0].items.map((i) => i.id)).toEqual(["a"]);
    expect(groups[0].isToday).toBe(true);
  });

  it("groups items last seen on the same day", () => {
    const groups = groupItemsByDay(
      [at(NOW - 5 * MIN, "a"), at(NOW - 3 * HOUR, "b")],
      seenOf,
      NOW
    );
    expect(groups).toHaveLength(1);
    expect(groups[0].items.map((i) => i.id)).toEqual(["a", "b"]);
  });

  it("separates items from different days", () => {
    const groups = groupItemsByDay(
      [at(NOW - 5 * MIN, "a"), at(NOW - DAY, "b")],
      seenOf,
      NOW
    );
    expect(groups).toHaveLength(2);
    expect(groups[0].isToday).toBe(true);
    expect(groups[1].isToday).toBe(false);
  });

  it("orders groups newest day first", () => {
    const groups = groupItemsByDay(
      [at(NOW - 3 * DAY, "old"), at(NOW - 5 * MIN, "new"), at(NOW - DAY, "mid")],
      seenOf,
      NOW
    );
    expect(groups.map((g) => g.items[0].id)).toEqual(["new", "mid", "old"]);
  });

  it("orders items newest first within a day", () => {
    const groups = groupItemsByDay(
      [at(NOW - 3 * HOUR, "b"), at(NOW - 5 * MIN, "a")],
      seenOf,
      NOW
    );
    expect(groups[0].items.map((i) => i.id)).toEqual(["a", "b"]);
  });

  it("collects never-seen items into a trailing group", () => {
    const groups = groupItemsByDay(
      [at(null, "never"), at(NOW - 5 * MIN, "seen")],
      seenOf,
      NOW
    );
    expect(groups).toHaveLength(2);
    expect(groups[0].items.map((i) => i.id)).toEqual(["seen"]);
    const last = groups[groups.length - 1];
    expect(last.isNever).toBe(true);
    expect(last.items.map((i) => i.id)).toEqual(["never"]);
  });

  it("puts never-seen last even when it is the only group", () => {
    const groups = groupItemsByDay([at(null, "x")], seenOf, NOW);
    expect(groups).toHaveLength(1);
    expect(groups[0].isNever).toBe(true);
  });

  it("keeps 23:59 yesterday separate from 00:01 today", () => {
    const lateYesterday = new Date(2026, 7, 26, 23, 59).getTime();
    const earlyToday = new Date(2026, 7, 27, 0, 1).getTime();
    const groups = groupItemsByDay(
      [at(lateYesterday, "y"), at(earlyToday, "t")],
      seenOf,
      NOW
    );
    expect(groups).toHaveLength(2);
  });

  it("does not mutate the input", () => {
    const input = [at(NOW - DAY, "a"), at(NOW, "b")];
    groupItemsByDay(input, seenOf, NOW);
    expect(input.map((i) => i.id)).toEqual(["a", "b"]);
  });
});
