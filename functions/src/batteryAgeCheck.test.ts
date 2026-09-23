// Whether a sensor's battery is overdue, and whether to say so again.
//
// Pure so it needs no emulator, matching deviceOnline.ts beside it. The
// Firestore and Telegram plumbing lives in deadSensorCheck.ts.
import { describe, it, expect } from "vitest";
import { Timestamp } from "firebase-admin/firestore";
import {
  DEFAULT_BATTERY_ALERT_MONTHS,
  batteryStartedAtMs,
  batteryAgeMonths,
  shouldAlertStaleBattery,
} from "./batteryAgeCheck";

const ts = (ms: number) => Timestamp.fromMillis(ms);
const NOW = Date.parse("2026-09-23T12:00:00Z");
const monthsAgo = (n: number) => {
  const d = new Date(NOW);
  d.setMonth(d.getMonth() - n);
  return d.getTime();
};

describe("batteryStartedAtMs", () => {
  it("prefers the recorded replacement date", () => {
    expect(
      batteryStartedAtMs({ batteryChangedAt: ts(5000), pairedAt: ts(1000) })
    ).toBe(5000);
  });

  it("falls back to pairedAt", () => {
    // Means a long-paired sensor is already overdue on the first run after
    // deploy, which is correct: that battery really is old.
    expect(
      batteryStartedAtMs({ batteryChangedAt: null, pairedAt: ts(1000) })
    ).toBe(1000);
    expect(batteryStartedAtMs({ pairedAt: ts(1000) })).toBe(1000);
  });

  it("returns null when both are missing", () => {
    // Never treated as epoch 0, which would fire a bogus alert immediately.
    expect(batteryStartedAtMs({})).toBeNull();
  });
});

describe("batteryAgeMonths", () => {
  it("counts whole calendar months", () => {
    expect(batteryAgeMonths(monthsAgo(13), NOW)).toBe(13);
    expect(batteryAgeMonths(NOW, NOW)).toBe(0);
  });

  it("never returns a negative age", () => {
    expect(batteryAgeMonths(monthsAgo(-5), NOW)).toBe(0);
  });
});

describe("shouldAlertStaleBattery", () => {
  const base = {
    startedAtMs: monthsAgo(13),
    alertSentAt: null,
    thresholdMonths: 12,
    nowMs: NOW,
  };

  it("fires when the battery is past the threshold and nothing was sent", () => {
    expect(shouldAlertStaleBattery(base)).toBe(true);
  });

  it("fires at exactly the threshold", () => {
    expect(shouldAlertStaleBattery({ ...base, startedAtMs: monthsAgo(12) })).toBe(
      true
    );
  });

  it("stays silent just under the threshold", () => {
    expect(shouldAlertStaleBattery({ ...base, startedAtMs: monthsAgo(11) })).toBe(
      false
    );
  });

  it("stays silent once an alert has been sent", () => {
    // The once-per-battery property. Recording a new change date clears this
    // marker in the web UI, which is what lets the NEXT battery alert.
    expect(
      shouldAlertStaleBattery({ ...base, alertSentAt: ts(NOW - 1000) })
    ).toBe(false);
  });

  it("stays silent when the threshold disables the alert", () => {
    expect(shouldAlertStaleBattery({ ...base, thresholdMonths: 0 })).toBe(false);
    expect(shouldAlertStaleBattery({ ...base, thresholdMonths: -1 })).toBe(false);
  });

  it("stays silent when the start date is unknown", () => {
    expect(shouldAlertStaleBattery({ ...base, startedAtMs: null })).toBe(false);
  });

  it("treats an undefined marker as not-yet-sent", () => {
    // Sensor docs predate the field, so undefined must mean "never alerted"
    // rather than being read as truthy and suppressing the alert forever.
    expect(shouldAlertStaleBattery({ ...base, alertSentAt: undefined })).toBe(
      true
    );
  });
});

describe("DEFAULT_BATTERY_ALERT_MONTHS", () => {
  it("matches the web default", () => {
    // Must equal the constant in web/src/features/configure/batteryAge.ts, or
    // the UI would highlight a different set of sensors than the alert fires
    // for. The two are separate packages, so nothing enforces this but a test.
    expect(DEFAULT_BATTERY_ALERT_MONTHS).toBe(12);
  });
});
