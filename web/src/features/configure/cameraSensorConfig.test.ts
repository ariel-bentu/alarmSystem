// Pure helpers for the per-sensor camera config (out-of-sight + channel).
// Extracted so the label/normalization logic can be pinned without mounting
// SensorsTab (which needs Firestore and auth context) — same reasoning as
// batteryAge.ts beside it.
import { describe, it, expect } from "vitest";
import { cameraChannelLabel, normalizeChannel } from "./cameraSensorConfig";

describe("cameraChannelLabel", () => {
  it("labels unset channel as all", () => {
    expect(cameraChannelLabel(undefined)).toBe("All channels");
    expect(cameraChannelLabel(0)).toBe("All channels");
    expect(cameraChannelLabel(2)).toBe("Camera 2");
  });
});

describe("normalizeChannel", () => {
  it("normalizes channel input", () => {
    expect(normalizeChannel("")).toBeUndefined();
    expect(normalizeChannel("all")).toBeUndefined();
    expect(normalizeChannel("3")).toBe(3);
    expect(normalizeChannel("99")).toBeUndefined();
  });
});
