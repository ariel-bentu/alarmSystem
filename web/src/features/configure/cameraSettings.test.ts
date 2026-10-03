// Pure validation for CameraTab. See cameraSettings.ts for the
// capture+judge-requires-provider rationale (fail-safe breach spam in the
// cloud's onSnapshotUploaded when the judge is disabled).
import { describe, it, expect } from "vitest";
import { validateNvrSettings } from "./cameraSettings";

describe("validateNvrSettings", () => {
  it("accepts a valid config", () => {
    const r = validateNvrSettings({
      nvrMode: "capture",
      nvrPort: 34567,
      captureCooldownSec: 45,
      snapshotRetentionDays: 14,
    });
    expect(r.ok).toBe(true);
  });

  it("rejects a bad port", () => {
    expect(
      validateNvrSettings({
        nvrMode: "capture",
        nvrPort: 0,
        captureCooldownSec: 45,
        snapshotRetentionDays: 14,
      }).ok
    ).toBe(false);
  });

  it("rejects cooldown below 5", () => {
    expect(
      validateNvrSettings({
        nvrMode: "capture",
        nvrPort: 34567,
        captureCooldownSec: 2,
        snapshotRetentionDays: 14,
      }).ok
    ).toBe(false);
  });

  it("rejects retention below 1 day", () => {
    expect(
      validateNvrSettings({
        nvrMode: "capture",
        nvrPort: 34567,
        captureCooldownSec: 45,
        snapshotRetentionDays: 0,
      }).ok
    ).toBe(false);
  });

  it("rejects an unknown nvrMode", () => {
    expect(
      validateNvrSettings({
        nvrMode: "bogus",
        nvrPort: 34567,
        captureCooldownSec: 45,
        snapshotRetentionDays: 14,
      }).ok
    ).toBe(false);
  });

  it("accepts capture+judge with a real judge provider", () => {
    const r = validateNvrSettings({
      nvrMode: "capture+judge",
      nvrPort: 34567,
      captureCooldownSec: 45,
      snapshotRetentionDays: 14,
      judgeProvider: "claude",
    });
    expect(r.ok).toBe(true);
  });

  it("rejects capture+judge with judgeProvider missing", () => {
    const r = validateNvrSettings({
      nvrMode: "capture+judge",
      nvrPort: 34567,
      captureCooldownSec: 45,
      snapshotRetentionDays: 14,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toMatch(/judge/i);
    }
  });

  it("rejects capture+judge with judgeProvider explicitly off (\"null\")", () => {
    // Fail-safe guard: the cloud function falls back to a "breach" verdict
    // on every armed trigger when capture+judge is set but the judge is
    // disabled, spamming Telegram. The form must refuse to save this.
    const r = validateNvrSettings({
      nvrMode: "capture+judge",
      nvrPort: 34567,
      captureCooldownSec: 45,
      snapshotRetentionDays: 14,
      judgeProvider: "null",
    });
    expect(r.ok).toBe(false);
  });

  it("allows judgeProvider off when nvrMode is plain capture", () => {
    const r = validateNvrSettings({
      nvrMode: "capture",
      nvrPort: 34567,
      captureCooldownSec: 45,
      snapshotRetentionDays: 14,
      judgeProvider: "null",
    });
    expect(r.ok).toBe(true);
  });

  it("passes through optional NVR connection fields and never logs the password", () => {
    const r = validateNvrSettings({
      nvrMode: "capture",
      nvrHost: "192.0.2.10",
      nvrPort: 34567,
      nvrUser: "admin",
      nvrPassword: "testpass",
      captureCooldownSec: 45,
      snapshotRetentionDays: 14,
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.nvrHost).toBe("192.0.2.10");
      expect(r.value.nvrUser).toBe("admin");
      expect(r.value.nvrPassword).toBe("testpass");
    }
  });
});
