import { describe, it, expect } from "vitest";
import { keepStoredEdge } from "./schedulePending";

// 2026-09-02 16:45:34 local (UTC+3) — the moment the arm fired in the
// production incident this guard exists to prevent.
const NOW = Date.UTC(2026, 8, 2, 13, 45, 34);
const TODAY_DISARM = Date.UTC(2026, 8, 2, 13, 48, 0); // 16:48 local, pending
const TOMORROW_DISARM = Date.UTC(2026, 8, 3, 13, 48, 0);

describe("keepStoredEdge", () => {
  it("keeps a pending edge when the doc was merely re-triggered", () => {
    // THE REGRESSION: scheduleTick wrote lastFiredAt, which re-triggered
    // onScheduleChange, which recomputed the disarm as TOMORROW and
    // overwrote today's still-pending 16:48. The house stayed armed.
    expect(
      keepStoredEdge({
        storedMs: TODAY_DISARM,
        computedMs: TOMORROW_DISARM,
        definitionChanged: false,
        nowMs: NOW,
      })
    ).toBe(true);
  });

  it("lets a real edit win even when it moves the edge later", () => {
    // Editing disarmTime 16:48 -> 17:30 must take effect. A naive
    // "always keep the earlier future value" rule would silently ignore it.
    expect(
      keepStoredEdge({
        storedMs: TODAY_DISARM,
        computedMs: Date.UTC(2026, 8, 2, 14, 30, 0),
        definitionChanged: true,
        nowMs: NOW,
      })
    ).toBe(false);
  });

  it("replaces a stored time that has already passed", () => {
    // Spent, not pending. This is what lets a schedule disabled for weeks
    // recompute from now instead of believing it owes a past fire.
    expect(
      keepStoredEdge({
        storedMs: NOW - 60_000,
        computedMs: TOMORROW_DISARM,
        definitionChanged: false,
        nowMs: NOW,
      })
    ).toBe(false);
  });

  it("takes the computed value when nothing is stored", () => {
    expect(
      keepStoredEdge({
        storedMs: null,
        computedMs: TOMORROW_DISARM,
        definitionChanged: false,
        nowMs: NOW,
      })
    ).toBe(false);
  });

  it("keeps a pending edge when recomputation yields nothing", () => {
    // e.g. the arm edge was removed; a disarm still owed today must survive.
    expect(
      keepStoredEdge({
        storedMs: TODAY_DISARM,
        computedMs: null,
        definitionChanged: false,
        nowMs: NOW,
      })
    ).toBe(true);
  });

  it("takes the computed value when it is EARLIER than the stored one", () => {
    // A sooner edge is never something to discard.
    expect(
      keepStoredEdge({
        storedMs: TOMORROW_DISARM,
        computedMs: TODAY_DISARM,
        definitionChanged: false,
        nowMs: NOW,
      })
    ).toBe(false);
  });

  it("treats a newly created schedule as a definition change", () => {
    // No `before` snapshot means nothing to preserve.
    expect(
      keepStoredEdge({
        storedMs: TODAY_DISARM,
        computedMs: TOMORROW_DISARM,
        definitionChanged: true,
        nowMs: NOW,
      })
    ).toBe(false);
  });
});
