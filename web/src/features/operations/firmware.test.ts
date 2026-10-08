import { describe, it, expect } from "vitest";
import {
  buildOtaCommand,
  firmwareOffer,
  isOtaInProgress,
  OTA_REQUEST_TTL_SEC,
  refusalKey,
} from "./firmware";
import type { FirmwareManifest, RtdbOtaState } from "@/types";

const latest: FirmwareManifest = {
  version: "2026.10.08-1432-abc1234",
  path: "firmware/2026.10.08-1432-abc1234/firmware.bin",
  size: 1_100_000,
  md5: "0123456789abcdef0123456789abcdef",
  sha256: "x",
  publishedAt: 1,
};

const boot = (fw?: string) => ({ reason: "power_on", at: 1, ...(fw ? { fw } : {}) });

describe("firmwareOffer", () => {
  it("offers a strictly newer release", () => {
    expect(firmwareOffer(boot("2026.10.01-0900-0000000"), latest)).toEqual({
      kind: "available",
      latest,
    });
  });

  it("does not offer the running version or an older one", () => {
    expect(firmwareOffer(boot(latest.version), latest).kind).toBe("current");
    // A newer local USB build must not be offered a "downgrade".
    expect(firmwareOffer(boot("2026.11.01-0000-fffffff-dirty"), latest).kind).toBe("current");
  });

  it("flags firmware that predates OTA as unable to update itself", () => {
    expect(firmwareOffer(boot(), latest).kind).toBe("unsupported");
  });

  it("distinguishes nothing-published from device-not-heard-from", () => {
    expect(firmwareOffer(boot("x"), null).kind).toBe("none");
    expect(firmwareOffer(null, latest).kind).toBe("unknown");
  });
});

describe("isOtaInProgress", () => {
  const now = 1_800_000_000_000;
  const state = (status: RtdbOtaState["status"], at = now): RtdbOtaState => ({
    status,
    version: "v",
    at,
  });

  it("is busy while downloading or rebooting", () => {
    expect(isOtaInProgress(state("downloading"), now)).toBe(true);
    expect(isOtaInProgress(state("rebooting"), now)).toBe(true);
  });

  it("is not busy once finished", () => {
    for (const s of ["ok", "failed", "refused", "rolled_back"] as const) {
      expect(isOtaInProgress(state(s), now)).toBe(false);
    }
    expect(isOtaInProgress(null, now)).toBe(false);
  });

  it("stops believing a device that went silent mid-download", () => {
    expect(isOtaInProgress(state("downloading", now - 16 * 60_000), now)).toBe(false);
  });

  it("trusts a pre-NTP timestamp rather than calling it stale", () => {
    expect(isOtaInProgress(state("downloading", 5000), now)).toBe(true);
  });
});

describe("buildOtaCommand", () => {
  it("copies the manifest the device verifies against, with a deadline", () => {
    const cmd = buildOtaCommand(latest, 1_800_000_000_500, 77);
    expect(cmd).toEqual({
      n: 77,
      version: latest.version,
      path: latest.path,
      md5: latest.md5,
      size: latest.size,
      until: 1_800_000_000 + OTA_REQUEST_TTL_SEC,
    });
  });
});

describe("refusalKey", () => {
  it("maps device verdicts and ignores unknown ones", () => {
    expect(refusalKey("siren_active")).toBe("fw.refused.siren");
    expect(refusalKey("whatever")).toBeNull();
    expect(refusalKey(undefined)).toBeNull();
  });
});
