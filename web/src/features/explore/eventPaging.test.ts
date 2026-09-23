import { describe, it, expect } from "vitest";
import { liveWindowStart, mergeEventPages } from "./eventPaging";

// A minimal stand-in for AlarmEvent: mergeEventPages only ever reads `id` and
// `timestamp`, so the table's other fields would be noise here.
const ev = (id: string, ms: number) => ({
  id,
  timestamp: { toMillis: () => ms },
});

describe("liveWindowStart", () => {
  it("returns local midnight of yesterday", () => {
    // 2026-09-23T14:30 local → 2026-09-22T00:00 local
    const now = new Date(2026, 8, 23, 14, 30).getTime();
    const start = new Date(liveWindowStart(now));

    expect(start.getFullYear()).toBe(2026);
    expect(start.getMonth()).toBe(8);
    expect(start.getDate()).toBe(22);
    expect(start.getHours()).toBe(0);
    expect(start.getMinutes()).toBe(0);
    expect(start.getSeconds()).toBe(0);
    expect(start.getMilliseconds()).toBe(0);
  });

  it("is already midnight-aligned when now IS midnight", () => {
    const now = new Date(2026, 8, 23, 0, 0, 0, 0).getTime();
    const start = new Date(liveWindowStart(now));

    expect(start.getDate()).toBe(22);
    expect(start.getHours()).toBe(0);
  });

  it("crosses a month boundary", () => {
    const now = new Date(2026, 8, 1, 9, 15).getTime();
    const start = new Date(liveWindowStart(now));

    expect(start.getMonth()).toBe(7); // August
    expect(start.getDate()).toBe(31);
  });

  it("crosses a year boundary", () => {
    const now = new Date(2026, 0, 1, 3, 0).getTime();
    const start = new Date(liveWindowStart(now));

    expect(start.getFullYear()).toBe(2025);
    expect(start.getMonth()).toBe(11);
    expect(start.getDate()).toBe(31);
  });

  it("handles a leap day", () => {
    const now = new Date(2028, 2, 1, 12, 0).getTime(); // 2028-03-01
    const start = new Date(liveWindowStart(now));

    expect(start.getMonth()).toBe(1); // February
    expect(start.getDate()).toBe(29);
  });

  // Date arithmetic on a fixed 86_400_000ms day breaks across a DST shift:
  // subtracting 24h from midnight lands at 23:00 or 01:00 of the wrong day.
  // Using the calendar setDate(-1) keeps it on local midnight either way.
  it("lands on local midnight across a DST transition", () => {
    // Israel (the project's timezone) springs forward in late March.
    const now = new Date(2026, 2, 28, 10, 0).getTime();
    const start = new Date(liveWindowStart(now));

    expect(start.getDate()).toBe(27);
    expect(start.getHours()).toBe(0);
    expect(start.getMinutes()).toBe(0);
  });

  it("is always in the past", () => {
    const now = Date.now();
    expect(liveWindowStart(now)).toBeLessThan(now);
  });
});

describe("mergeEventPages", () => {
  it("returns an empty list when both layers are empty", () => {
    expect(mergeEventPages([], [])).toEqual([]);
  });

  it("returns the live layer when there is no history", () => {
    const live = [ev("b", 200), ev("a", 100)];
    expect(mergeEventPages(live, []).map((e) => e.id)).toEqual(["b", "a"]);
  });

  it("returns the history layer when the live layer is empty", () => {
    const history = [ev("y", 50), ev("x", 10)];
    expect(mergeEventPages([], history).map((e) => e.id)).toEqual(["y", "x"]);
  });

  it("concatenates live above history, newest first", () => {
    const live = [ev("d", 400), ev("c", 300)];
    const history = [ev("b", 200), ev("a", 100)];

    expect(mergeEventPages(live, history).map((e) => e.id)).toEqual([
      "d",
      "c",
      "b",
      "a",
    ]);
  });

  // The live query is `>= boundary` and history is `< boundary`, so the two
  // should never overlap. They can still collide for one tick: an event
  // arriving mid-page-fetch lands in the live snapshot AND in the page the
  // server had already begun assembling. Rendering it twice would give React
  // duplicate keys, so dedupe by id and let the live copy win.
  it("drops a history row whose id is already in the live layer", () => {
    const live = [ev("dup", 300), ev("c", 250)];
    const history = [ev("dup", 300), ev("b", 200)];

    expect(mergeEventPages(live, history).map((e) => e.id)).toEqual([
      "dup",
      "c",
      "b",
    ]);
  });

  it("dedupes repeats within the history layer itself", () => {
    // Two overlapping pages, e.g. after a cursor is re-fetched.
    const history = [ev("b", 200), ev("a", 100), ev("a", 100)];

    expect(mergeEventPages([], history).map((e) => e.id)).toEqual(["b", "a"]);
  });

  it("re-sorts descending when a layer arrives out of order", () => {
    const live = [ev("a", 100), ev("c", 300), ev("b", 200)];

    expect(mergeEventPages(live, []).map((e) => e.id)).toEqual([
      "c",
      "b",
      "a",
    ]);
  });

  it("orders a history row newer than a live row correctly", () => {
    // Defensive: should not happen given the query boundaries, but the merge
    // must not rely on the caller's layering to produce a sorted list.
    const live = [ev("old", 100)];
    const history = [ev("new", 900)];

    expect(mergeEventPages(live, history).map((e) => e.id)).toEqual([
      "new",
      "old",
    ]);
  });

  it("keeps both rows when two events share a timestamp", () => {
    const merged = mergeEventPages([ev("a", 500)], [ev("b", 500)]);
    expect(merged).toHaveLength(2);
    expect(merged.map((e) => e.id).sort()).toEqual(["a", "b"]);
  });

  it("does not mutate its inputs", () => {
    const live = [ev("a", 100), ev("c", 300)];
    const history = [ev("b", 200)];
    mergeEventPages(live, history);

    expect(live.map((e) => e.id)).toEqual(["a", "c"]);
    expect(history.map((e) => e.id)).toEqual(["b"]);
  });
});
