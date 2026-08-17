import { describe, it, expect } from "vitest";
import { buildRawEvent } from "./rawEvent";

describe("buildRawEvent", () => {
  it("returns correct shape for trigger event", () => {
    const result = buildRawEvent("trigger", false, -65);
    expect(result).toEqual({ event: "trigger", battery_low: false, rssi: -65 });
  });

  it("returns correct shape for tamper event", () => {
    const result = buildRawEvent("tamper", true, -80);
    expect(result).toEqual({ event: "tamper", battery_low: true, rssi: -80 });
  });

  it("returns correct shape for battery_low event", () => {
    const result = buildRawEvent("battery_low", true, -90);
    expect(result).toEqual({ event: "battery_low", battery_low: true, rssi: -90 });
  });

  it("preserves exact rssi value", () => {
    const result = buildRawEvent("trigger", false, -42);
    expect(result.rssi).toBe(-42);
  });

  it("batteryLow false when explicitly set", () => {
    const result = buildRawEvent("trigger", false, -50);
    expect(result.battery_low).toBe(false);
  });

  it("batteryLow true when explicitly set", () => {
    const result = buildRawEvent("trigger", true, -50);
    expect(result.battery_low).toBe(true);
  });

  it("event field matches input string exactly", () => {
    const result = buildRawEvent("custom_type", false, 0);
    expect(result.event).toBe("custom_type");
  });
});
