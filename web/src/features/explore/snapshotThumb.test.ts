import { describe, expect, it } from "vitest";
import { snapshotSummary } from "./snapshotThumb";
import type { TimelineSnapshotDoc } from "@/types";

describe("snapshotSummary", () => {
  it("summarizes a breach entry with images", () => {
    const s = snapshotSummary({
      id: "0x2E5B73_1",
      snapshots: [{ channel: 1, url: "u" }],
      aiNote: "confirmed breach (AI): person at door",
    } as TimelineSnapshotDoc);
    expect(s.hasImages).toBe(true);
    expect(s.verdictLabel).toBe("Confirmed breach (AI)");
  });

  it("summarizes a safe entry with images", () => {
    const s = snapshotSummary({
      id: "0x2E5B73_2",
      snapshots: [{ channel: 1, url: "u" }],
      aiNote: "false positive (AI): empty yard",
    } as TimelineSnapshotDoc);
    expect(s.hasImages).toBe(true);
    expect(s.verdictLabel).toBe("False positive (AI)");
  });

  it("has images but no judge note", () => {
    const s = snapshotSummary({
      id: "0x2E5B73_3",
      snapshots: [{ channel: 1, url: "u" }],
    } as TimelineSnapshotDoc);
    expect(s.hasImages).toBe(true);
    expect(s.verdictLabel).toBeUndefined();
  });

  it("no images, no verdict", () => {
    const s = snapshotSummary({ id: "0x2E5B73_4" } as TimelineSnapshotDoc);
    expect(s.hasImages).toBe(false);
    expect(s.verdictLabel).toBeUndefined();
  });

  it("undefined entry", () => {
    const s = snapshotSummary(undefined);
    expect(s.hasImages).toBe(false);
    expect(s.verdictLabel).toBeUndefined();
  });

  it("empty snapshots array counts as no images", () => {
    const s = snapshotSummary({
      id: "0x2E5B73_5",
      snapshots: [],
      aiNote: "confirmed breach (AI): person at door",
    } as TimelineSnapshotDoc);
    expect(s.hasImages).toBe(false);
    expect(s.verdictLabel).toBe("Confirmed breach (AI)");
  });
});
