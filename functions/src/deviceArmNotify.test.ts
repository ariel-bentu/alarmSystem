import { describe, it, expect } from "vitest";
import {
  shouldSuppressDeviceArmNotification,
  armEventSourceLabel,
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
});
