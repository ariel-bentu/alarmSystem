import { describe, it, expect } from "vitest";
import {
  decideOfflineAction,
  offlineThresholdMs,
  formatSilence,
  OFFLINE_THRESHOLD_ARMED_MS,
  OFFLINE_THRESHOLD_DISARMED_MS,
} from "./deviceOnline";

const NOW = 1_788_240_741_000;

describe("offlineThresholdMs", () => {
  it("is far shorter while armed", () => {
    // The armed case is the security-relevant one: a dead controller then
    // means an unmonitored house.
    expect(offlineThresholdMs(true)).toBe(OFFLINE_THRESHOLD_ARMED_MS);
    expect(offlineThresholdMs(false)).toBe(OFFLINE_THRESHOLD_DISARMED_MS);
    expect(offlineThresholdMs(true)).toBeLessThan(offlineThresholdMs(false));
  });
});

describe("decideOfflineAction", () => {
  const base = { alertSent: false, armed: true, nowMs: NOW };

  it("stays quiet while heartbeats are recent", () => {
    expect(
      decideOfflineAction({ ...base, lastSeenMs: NOW - 60_000 })
    ).toBe("none");
  });

  it("alerts once armed silence passes 5 minutes", () => {
    expect(
      decideOfflineAction({ ...base, lastSeenMs: NOW - 6 * 60_000 })
    ).toBe("alert_offline");
  });

  it("does not alert at 6 minutes when disarmed", () => {
    // Disarmed usually means someone is home and possibly power-cycling.
    expect(
      decideOfflineAction({
        ...base,
        armed: false,
        lastSeenMs: NOW - 6 * 60_000,
      })
    ).toBe("none");
  });

  it("still alerts when disarmed silence passes 2 hours", () => {
    // Quieter, but never silent: a controller that died disarmed must be
    // found before the next arm.
    expect(
      decideOfflineAction({
        ...base,
        armed: false,
        lastSeenMs: NOW - 3 * 60 * 60_000,
      })
    ).toBe("alert_offline");
  });

  it("does not repeat an alert that was already sent", () => {
    // Without the latch, a single outage would alert once per scheduler run.
    expect(
      decideOfflineAction({
        ...base,
        alertSent: true,
        lastSeenMs: NOW - 60 * 60_000,
      })
    ).toBe("none");
  });

  it("reports recovery only to someone who was told it went down", () => {
    expect(
      decideOfflineAction({ ...base, alertSent: true, lastSeenMs: NOW - 1000 })
    ).toBe("alert_back_online");
    expect(
      decideOfflineAction({ ...base, alertSent: false, lastSeenMs: NOW - 1000 })
    ).toBe("none");
  });

  it("never alerts for a device that has never reported", () => {
    // Otherwise every freshly provisioned project alerts immediately.
    expect(decideOfflineAction({ ...base, lastSeenMs: null })).toBe("none");
    expect(
      decideOfflineAction({ ...base, alertSent: true, lastSeenMs: null })
    ).toBe("none");
  });

  it("treats a future timestamp as alive rather than negative silence", () => {
    expect(
      decideOfflineAction({ ...base, lastSeenMs: NOW + 5000 })
    ).toBe("none");
    expect(
      decideOfflineAction({ ...base, alertSent: true, lastSeenMs: NOW + 5000 })
    ).toBe("alert_back_online");
  });

  it("does not fire exactly at the threshold, only past it", () => {
    expect(
      decideOfflineAction({
        ...base,
        lastSeenMs: NOW - OFFLINE_THRESHOLD_ARMED_MS,
      })
    ).toBe("none");
    expect(
      decideOfflineAction({
        ...base,
        lastSeenMs: NOW - OFFLINE_THRESHOLD_ARMED_MS - 1,
      })
    ).toBe("alert_offline");
  });
});

describe("formatSilence", () => {
  it("uses minutes below an hour", () => {
    expect(formatSilence(6 * 60_000)).toBe("6m");
    expect(formatSilence(59 * 60_000)).toBe("59m");
  });

  it("never rounds a real outage down to 0m", () => {
    expect(formatSilence(30_000)).toBe("1m");
  });

  it("uses hours, with minutes when present", () => {
    expect(formatSilence(60 * 60_000)).toBe("1h");
    expect(formatSilence(90 * 60_000)).toBe("1h 30m");
  });

  it("uses days for long outages", () => {
    // The real incident was ~28h; "1680m" would be useless at a glance.
    expect(formatSilence(28 * 60 * 60_000)).toBe("1d 4h");
    expect(formatSilence(48 * 60 * 60_000)).toBe("2d");
  });
});
