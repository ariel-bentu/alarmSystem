import { describe, it, expect } from "vitest";
import { classifyEvent, eventFromReport } from "./sensorEventPolicy";

describe("classifyEvent — the behaviour table", () => {
  it("routes a trigger to the alarm rules, notified via the project toggle", () => {
    const p = classifyEvent("trigger");
    expect(p.eventType).toBe("trigger");
    expect(p.evaluateRules).toBe(true);
    expect(p.alwaysNotify).toBe(false);
    expect(p.onceMarker).toBeNull();
    expect(p.notify).toBe(true);
  });

  it("treats an unknown nibble exactly as a trigger", () => {
    // The smoke detector sits on nibble 0x2, which is in no table and has
    // never fired in 3,089 events. Routing it anywhere else would silently
    // disable a smoke alarm — the worst outcome of this refactor.
    expect(classifyEvent("unknown")).toEqual(classifyEvent("trigger"));
  });

  it("keeps tamper OUT of rule evaluation — it has its own path", () => {
    // Tamper sirens even while disarmed, which no rule can express.
    const p = classifyEvent("tamper");
    expect(p.eventType).toBe("tamper");
    expect(p.evaluateRules).toBe(false);
    expect(p.alwaysNotify).toBe(true);
    expect(p.notify).toBe(true);
  });

  it("notifies on EVERY tamper, with no once-marker", () => {
    // Unlike water, tamper is an event rather than a standing condition: a
    // second tamper is a second act of interference and must be reported.
    expect(classifyEvent("tamper").onceMarker).toBeNull();
  });

  it("latches water to one alert per condition", () => {
    // Without the marker a leaking sensor would Telegram on every packet.
    const p = classifyEvent("water");
    expect(p.eventType).toBe("water");
    expect(p.onceMarker).toBe("waterAlertSentAt");
    expect(p.evaluateRules).toBe(false);
    expect(p.alwaysNotify).toBe(true);
  });

  it("latches battery_low to the SAME field the stale-battery check uses", () => {
    // Deliberately one field, not two: both mean "the user has been told
    // this battery needs attention", and two fields would let one battery
    // produce two different Telegrams.
    const p = classifyEvent("battery_low");
    expect(p.onceMarker).toBe("batteryAlertSentAt");
    expect(p.evaluateRules).toBe(false);
  });

  it("records close but notifies nothing and evaluates nothing", () => {
    // Deliberately ignored: the timeline stays complete, but the system has
    // no concept of a door's open/closed STATE, only of events.
    const p = classifyEvent("close");
    expect(p.eventType).toBe("close");
    expect(p.notify).toBe(false);
    expect(p.evaluateRules).toBe(false);
    expect(p.alwaysNotify).toBe(false);
  });

  it("evaluates rules for trigger ONLY", () => {
    // One assertion pinning the whole "which events can raise an alarm"
    // question, so adding an event type forces a decision here.
    const evaluated = (["trigger", "unknown", "tamper", "water", "battery_low", "close"] as const)
      .filter((e) => classifyEvent(e).evaluateRules);
    expect(evaluated).toEqual(["trigger", "unknown"]);
  });
});

describe("eventFromReport", () => {
  it("lets the device's explicit non-trigger string win", () => {
    // deviceIngest (legacy, used by smoke/) accepts any event string.
    expect(eventFromReport("tamper", "trigger")).toBe("tamper");
    expect(eventFromReport("water", "trigger")).toBe("water");
    expect(eventFromReport("close", "trigger")).toBe("close");
    expect(eventFromReport("battery_low", "trigger")).toBe("battery_low");
  });

  it("falls back to the nibble for a plain 'trigger'", () => {
    // This is the important case: the firmware hardcodes "trigger" today, so
    // reading the reported string alone is exactly why the tamper branch had
    // never once run. The nibble is the real evidence.
    expect(eventFromReport("trigger", "tamper")).toBe("tamper");
    expect(eventFromReport("trigger", "close")).toBe("close");
  });

  it("falls back to the nibble for an absent or unrecognised string", () => {
    expect(eventFromReport(undefined, "tamper")).toBe("tamper");
    expect(eventFromReport("", "water")).toBe("water");
    expect(eventFromReport("something-else", "trigger")).toBe("trigger");
  });
});
