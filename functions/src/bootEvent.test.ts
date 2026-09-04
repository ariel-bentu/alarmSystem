import { describe, it, expect } from "vitest";
import {
  isTrustworthyBootTime,
  bootEventTimeMs,
  bootReasonLabel,
} from "./bootEvent";

describe("isTrustworthyBootTime", () => {
  it("accepts a real wall-clock timestamp", () => {
    expect(isTrustworthyBootTime(1788521384000)).toBe(true);
  });

  it("rejects a pre-NTP timestamp", () => {
    // Observed on real hardware 2026-09-04: the device wrote state/boot before
    // NTP synced and reported at=15000 — 15 seconds past the epoch.
    expect(isTrustworthyBootTime(15000)).toBe(false);
    expect(isTrustworthyBootTime(0)).toBe(false);
  });

  it("rejects non-numeric values", () => {
    expect(isTrustworthyBootTime("1788521384000")).toBe(false);
    expect(isTrustworthyBootTime(undefined)).toBe(false);
    expect(isTrustworthyBootTime(null)).toBe(false);
  });
});

describe("bootEventTimeMs", () => {
  const now = 1788600000000;

  it("uses the device timestamp when it is trustworthy", () => {
    expect(bootEventTimeMs(1788521384000, now)).toBe(1788521384000);
  });

  it("falls back to server time for a pre-NTP boot", () => {
    // Without this the row lands in 1970, sorts below every real event, and
    // is invisible in the timeline it was added to appear in.
    expect(bootEventTimeMs(15000, now)).toBe(now);
  });

  it("falls back to server time when at is missing entirely", () => {
    expect(bootEventTimeMs(undefined, now)).toBe(now);
  });
});

describe("bootReasonLabel", () => {
  it("passes a known reason through untranslated", () => {
    // The UI owns reason -> human text (bootReasonKey), so storing raw keeps
    // the database language-neutral.
    expect(bootReasonLabel("twdt")).toBe("twdt");
    expect(bootReasonLabel("panic")).toBe("panic");
  });

  it("falls back to 'unknown' for absent or blank reasons", () => {
    expect(bootReasonLabel(undefined)).toBe("unknown");
    expect(bootReasonLabel("")).toBe("unknown");
    expect(bootReasonLabel("   ")).toBe("unknown");
    expect(bootReasonLabel(42)).toBe("unknown");
  });

  it("trims surrounding whitespace", () => {
    expect(bootReasonLabel(" brownout ")).toBe("brownout");
  });
});
