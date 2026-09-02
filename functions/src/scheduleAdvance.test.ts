import { describe, it, expect } from "vitest";
import { planAdvance } from "./scheduleAdvance";

// 2026-09-02 16:23 local (UTC+3) — the arm edge of the schedule that
// exposed this bug in production.
const NOW = Date.UTC(2026, 8, 2, 13, 23, 8);
const TOMORROW_ARM = new Date(Date.UTC(2026, 8, 3, 13, 23, 0));
const TOMORROW_DISARM = new Date(Date.UTC(2026, 8, 3, 13, 26, 0));
const TODAY_DISARM_MS = Date.UTC(2026, 8, 2, 13, 26, 0);

describe("planAdvance", () => {
  it("does NOT touch the pending disarm when the arm fires", () => {
    // The regression: arm 16:23 fired and rewrote nextDisarmAt to tomorrow,
    // so today's 16:26 disarm never became due and the house stayed armed.
    const plan = planAdvance({
      edge: "arm",
      nextArmAt: TOMORROW_ARM,
      nextDisarmAt: TOMORROW_DISARM,
      storedOtherEdgeMs: TODAY_DISARM_MS,
      nowMs: NOW,
    });
    expect(plan.writeArm).toBe(true);
    expect(plan.writeDisarm).toBe(false);
    expect(plan.disable).toBe(false);
  });

  it("does NOT touch the pending arm when the disarm fires", () => {
    const plan = planAdvance({
      edge: "disarm",
      nextArmAt: TOMORROW_ARM,
      nextDisarmAt: TOMORROW_DISARM,
      storedOtherEdgeMs: Date.UTC(2026, 8, 3, 13, 23, 0),
      nowMs: NOW,
    });
    expect(plan.writeDisarm).toBe(true);
    expect(plan.writeArm).toBe(false);
  });

  it("retires a one-time schedule with nothing left on either edge", () => {
    const plan = planAdvance({
      edge: "disarm",
      nextArmAt: null,
      nextDisarmAt: null,
      storedOtherEdgeMs: null,
      nowMs: NOW,
    });
    expect(plan.disable).toBe(true);
  });

  it("does NOT retire while the untouched edge is still pending", () => {
    // Disabling here would strand the system armed with a disarm still owed
    // — the same failure as the original bug, in a different disguise.
    const plan = planAdvance({
      edge: "arm",
      nextArmAt: null,
      nextDisarmAt: null,
      storedOtherEdgeMs: TODAY_DISARM_MS,
      nowMs: NOW,
    });
    expect(plan.disable).toBe(false);
  });

  it("retires when the other edge's stored time has already passed", () => {
    // A stale timestamp in the past is not 'pending' and must not keep a
    // finished one-time schedule alive forever.
    const plan = planAdvance({
      edge: "arm",
      nextArmAt: null,
      nextDisarmAt: null,
      storedOtherEdgeMs: NOW - 60_000,
      nowMs: NOW,
    });
    expect(plan.disable).toBe(true);
  });

  it("keeps a recurring schedule enabled", () => {
    const plan = planAdvance({
      edge: "arm",
      nextArmAt: TOMORROW_ARM,
      nextDisarmAt: TOMORROW_DISARM,
      storedOtherEdgeMs: null,
      nowMs: NOW,
    });
    expect(plan.disable).toBe(false);
  });
});
