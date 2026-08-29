import { describe, it, expect } from "vitest";
import { parseSirenAddressEvent } from "./onSirenAddress";

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
