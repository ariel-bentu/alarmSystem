import { describe, it, expect } from "vitest";
import { decideEdge, STALE_CUTOFF_MS } from "./scheduleDecision";

const now = new Date("2026-01-15T23:00:00.000Z");

describe("decideEdge", () => {
  it("fires an edge due right now", () => {
    expect(decideEdge(now, now, true, "arm")).toBe("fire");
  });

  it("fires an edge a few minutes late", () => {
    const due = new Date(now.getTime() - 5 * 60_000);
    expect(decideEdge(due, now, true, "arm")).toBe("fire");
  });

  it("skips an edge later than the stale cutoff", () => {
    const due = new Date(now.getTime() - STALE_CUTOFF_MS - 1000);
    expect(decideEdge(due, now, true, "arm")).toBe("skip_stale");
  });

  it("reports not_due for a future edge", () => {
    const due = new Date(now.getTime() + 60_000);
    expect(decideEdge(due, now, true, "arm")).toBe("not_due");
  });

  it("skips an arm edge whose profile is disabled", () => {
    expect(decideEdge(now, now, false, "arm")).toBe("skip_disabled_profile");
  });

  it("still fires a disarm edge when the profile is disabled", () => {
    // Releasing is always safe, so a disabled profile must not strand the
    // system armed.
    expect(decideEdge(now, now, false, "disarm")).toBe("fire");
  });

  it("prefers staleness over the disabled-profile reason", () => {
    const due = new Date(now.getTime() - STALE_CUTOFF_MS - 1000);
    expect(decideEdge(due, now, false, "arm")).toBe("skip_stale");
  });
});
