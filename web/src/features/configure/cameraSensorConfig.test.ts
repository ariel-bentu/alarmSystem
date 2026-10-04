// Pure helpers for the per-sensor camera selection (a LIST of channels).
// Extracted so the normalization logic can be pinned without mounting
// SensorsTab (which needs Firestore and auth context) — same reasoning as
// batteryAge.ts beside it.
import { describe, it, expect } from "vitest";
import { normalizeCameras, toCameraMask } from "./cameraSensorConfig";

describe("normalizeCameras", () => {
  it("keeps in-range channels, sorted", () => {
    expect(normalizeCameras([3, 1])).toEqual([1, 3]);
  });

  it("de-duplicates repeated channels", () => {
    expect(normalizeCameras([2, 2, 2])).toEqual([2]);
  });

  it("drops channels outside 1-8", () => {
    expect(normalizeCameras([0, 9, 100, -1, 4])).toEqual([4]);
  });

  it("drops non-integers rather than rounding them", () => {
    // Rounding would silently store a DIFFERENT camera than the one meant.
    expect(normalizeCameras([1.5, NaN, 2])).toEqual([2]);
  });

  it("returns an empty list for junk input", () => {
    expect(normalizeCameras(undefined)).toEqual([]);
    expect(normalizeCameras("1,2")).toEqual([]);
    expect(normalizeCameras(null)).toEqual([]);
  });

  it("returns an empty list for an empty selection", () => {
    // Empty is the authoritative 'capture nothing for this sensor' state,
    // NOT a fallback to all channels.
    expect(normalizeCameras([])).toEqual([]);
  });

  it("ignores string entries mixed into the array", () => {
    expect(normalizeCameras([1, "2", {}])).toEqual([1]);
  });
});

describe("toCameraMask", () => {
  it("maps channel N to bit N-1", () => {
    expect(toCameraMask([1])).toBe(0b00000001);
    expect(toCameraMask([2])).toBe(0b00000010);
    expect(toCameraMask([8])).toBe(0b10000000);
  });

  it("ORs several channels into one byte", () => {
    expect(toCameraMask([1, 3])).toBe(0b00000101);
    expect(toCameraMask([1, 2, 3, 4, 5, 6, 7, 8])).toBe(0xff);
  });

  it("maps no cameras to a zero mask", () => {
    // 0 is what tells the device to capture nothing for this sensor, and
    // what lets buildConfig omit the whole array.
    expect(toCameraMask([])).toBe(0);
  });

  it("ignores out-of-range channels instead of overflowing the byte", () => {
    expect(toCameraMask([0, 9, 2])).toBe(0b00000010);
  });
});
