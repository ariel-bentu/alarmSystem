import { describe, it, expect } from "vitest";
import {
  shouldSuppressDeviceArmNotification,
  armEventSourceLabel,
  parseArmSource,
} from "./deviceArmNotify";

describe("shouldSuppressDeviceArmNotification", () => {
  it("suppresses when commands/armed already matches — cloud-initiated, already reported", () => {
    expect(shouldSuppressDeviceArmNotification(true, true)).toBe(true);
    expect(shouldSuppressDeviceArmNotification(false, false)).toBe(true);
  });

  it("does not suppress when they differ — device-initiated", () => {
    expect(shouldSuppressDeviceArmNotification(true, false)).toBe(false);
    expect(shouldSuppressDeviceArmNotification(false, true)).toBe(false);
  });

  it("does not suppress when commands/armed is absent", () => {
    expect(shouldSuppressDeviceArmNotification(null, true)).toBe(false);
    expect(shouldSuppressDeviceArmNotification(null, false)).toBe(false);
  });
});

describe("armEventSourceLabel", () => {
  it("names the remote so the timeline distinguishes it", () => {
    expect(armEventSourceLabel("remote")).toBe("Remote");
  });

  it("falls back to Device for local and unknown sources", () => {
    expect(armEventSourceLabel("local")).toBe("Device");
    expect(armEventSourceLabel(null)).toBe("Device");
  });

  it("still says Remote when the source carries an identity", () => {
    // The label is the FALLBACK used when the identity matches no paired
    // remote; it must not regress to "Device" just because a suffix exists.
    expect(armEventSourceLabel("remote:E45CA")).toBe("Remote");
  });
});

describe("parseArmSource", () => {
  it("extracts the identity a remote reports", () => {
    expect(parseArmSource("remote:E45CA")).toEqual({
      kind: "remote",
      identity: "E45CA",
    });
  });

  it("normalises the identity to uppercase, no 0x prefix", () => {
    // The device formats %05X, but a hand-written or older value may differ.
    // Firestore stores Remote.identity as "0xE45CA", so the comparison has to
    // happen on a canonical form or the lookup silently never matches.
    expect(parseArmSource("remote:e45ca")).toEqual({
      kind: "remote",
      identity: "E45CA",
    });
    expect(parseArmSource("remote:0xE45CA")).toEqual({
      kind: "remote",
      identity: "E45CA",
    });
  });

  it("handles a bare remote from older firmware", () => {
    // Backward compatibility: firmware that predates the identity suffix is
    // still in the field, and must keep producing a usable event.
    expect(parseArmSource("remote")).toEqual({ kind: "remote" });
  });

  it("recognises local and cloud sources", () => {
    expect(parseArmSource("local")).toEqual({ kind: "local" });
    expect(parseArmSource("cloud")).toEqual({ kind: "cloud" });
  });

  it("treats an absent source as cloud", () => {
    expect(parseArmSource(null)).toEqual({ kind: "cloud" });
  });

  it("drops a malformed identity rather than looking up nonsense", () => {
    // An empty or non-hex suffix means the value was corrupted in transit;
    // returning it would produce a Firestore query that matches nothing and
    // an event labelled with garbage. Degrade to the bare-remote shape.
    expect(parseArmSource("remote:")).toEqual({ kind: "remote" });
    expect(parseArmSource("remote:ZZZZZ")).toEqual({ kind: "remote" });
  });

  it("treats an unrecognised source as cloud", () => {
    expect(parseArmSource("something-else")).toEqual({ kind: "cloud" });
  });
});
