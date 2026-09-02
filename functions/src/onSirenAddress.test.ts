import { describe, it, expect } from "vitest";
import { canonicalSirenAddress, parseSirenAddressEvent } from "./onSirenAddress";

describe("parseSirenAddressEvent", () => {
  it("extracts the base address from a device report", () => {
    expect(parseSirenAddressEvent({ event: "siren_address", value: "0xA1B2C0" }))
      .toBe(0xa1b2c0);
  });

  it("ignores ordinary sensor events", () => {
    expect(parseSirenAddressEvent({ event: "trigger" })).toBeNull();
  });

  it("rejects a malformed address rather than writing garbage to state", () => {
    expect(parseSirenAddressEvent({ event: "siren_address", value: "nope" }))
      .toBeNull();
  });

  it("rejects an address wider than the 24-bit frame", () => {
    expect(parseSirenAddressEvent({ event: "siren_address", value: "0xFF123456" }))
      .toBeNull();
  });
});

describe("canonicalSirenAddress", () => {
  it("round-trips a reported address unchanged", () => {
    const parsed = parseSirenAddressEvent({
      event: "siren_address",
      value: "0xA1B2C0",
    });
    expect(canonicalSirenAddress(parsed!)).toBe("0xA1B2C0");
  });

  // The device re-reports its address on EVERY boot. If the canonical form
  // did not match what is already stored, the handler's equality check would
  // miss and each reboot would rewrite the project doc — triggering a config
  // rebuild and an RTDB push to the device every time.
  it("is stable, so a re-reported address compares equal to the stored one", () => {
    const stored = canonicalSirenAddress(0xa1b2c0);
    expect(canonicalSirenAddress(0xa1b2c0)).toBe(stored);
  });

  // Low addresses must not lose their leading zeros, or the stored string
  // would never compare equal and every boot would rewrite the doc.
  it("zero-pads to six digits", () => {
    expect(canonicalSirenAddress(0x00b2c0)).toBe("0x00B2C0");
  });

  it("upper-cases, matching the form the device reports", () => {
    expect(canonicalSirenAddress(0xabcdef)).toBe("0xABCDEF");
  });
});
