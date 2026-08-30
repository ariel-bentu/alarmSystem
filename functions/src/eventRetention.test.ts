import { describe, it, expect } from "vitest";
import { expiredKeys, cutoffFrom, EVENT_RETENTION_MS } from "./eventRetention";

describe("expiredKeys", () => {
  it("returns keys strictly older than the cutoff", () => {
    expect(expiredKeys(["100", "200", "300"], 250)).toEqual(["100", "200"]);
  });

  it("keeps a key exactly at the cutoff", () => {
    // The cutoff is "delete anything older than 24h", so an event landing
    // precisely on the boundary is still within retention.
    expect(expiredKeys(["100", "200"], 200)).toEqual(["100"]);
  });

  it("returns nothing when every key is recent", () => {
    expect(expiredKeys(["500", "600"], 100)).toEqual([]);
  });

  it("returns nothing for no keys", () => {
    expect(expiredKeys([], 1000)).toEqual([]);
  });

  it("ignores non-numeric keys rather than deleting them", () => {
    // A malformed key has no decidable age. Deleting it would be guessing,
    // so it is left alone and shows up as a stale node instead of data loss.
    expect(expiredKeys(["abc", "100", ""], 250)).toEqual(["100"]);
  });

  it("handles epoch-ms keys beyond 2^31", () => {
    // Real keys are epoch milliseconds (~1.7e12) — well past int32.
    expect(expiredKeys(["1750000000000", "1760000000000"], 1755000000000)).toEqual([
      "1750000000000",
    ]);
  });
});

describe("cutoffFrom", () => {
  it("is one retention window before now", () => {
    expect(cutoffFrom(1_000_000_000_000)).toBe(1_000_000_000_000 - EVENT_RETENTION_MS);
  });

  it("retains for 24 hours", () => {
    expect(EVENT_RETENTION_MS).toBe(24 * 60 * 60 * 1000);
  });
});
