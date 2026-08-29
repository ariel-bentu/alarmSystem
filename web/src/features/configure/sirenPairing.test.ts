import { describe, it, expect } from "vitest";
import { buildPairCommand, formatSirenAddress } from "./sirenPairing";

describe("buildPairCommand", () => {
  it("expires the request after the pairing window", () => {
    const nowMs = 1_700_000_000_000;
    const cmd = buildPairCommand(nowMs, 120);
    // until is an epoch SECOND, not a millisecond — the device compares it
    // against time(nullptr).
    expect(cmd.until).toBe(Math.floor(nowMs / 1000) + 120);
  });

  it("defaults to a window that covers poll latency plus transmit time", () => {
    // The device polls /commands every ~15s alternating with /config, so a
    // command can take ~30s to arrive, and pairing then transmits for 10s. The
    // window must comfortably exceed both or the device discards its own
    // request as expired.
    const cmd = buildPairCommand(1_700_000_000_000);
    const seconds = cmd.until - 1_700_000_000;
    expect(seconds).toBeGreaterThanOrEqual(120);
  });

  it("produces a different nonce each call so a repeat is not deduped", () => {
    const a = buildPairCommand(1_700_000_000_000);
    const b = buildPairCommand(1_700_000_000_000);
    expect(a.n).not.toBe(b.n);
  });

  it("keeps the nonce a positive integer the firmware can parse as uint32", () => {
    const cmd = buildPairCommand(1_700_000_000_000);
    expect(Number.isInteger(cmd.n)).toBe(true);
    expect(cmd.n).toBeGreaterThan(0);
    expect(cmd.n).toBeLessThanOrEqual(0xffffffff);
  });
});

describe("formatSirenAddress", () => {
  it("renders as the 0x-prefixed 6-digit hex used everywhere else", () => {
    expect(formatSirenAddress(0xa1b2c0)).toBe("0xA1B2C0");
  });

  it("pads short addresses to six digits", () => {
    expect(formatSirenAddress(0x0012c0)).toBe("0x0012C0");
  });

  it("reports an unknown address rather than rendering a misleading 0x000000", () => {
    expect(formatSirenAddress(null)).toBe("unknown");
  });
});
