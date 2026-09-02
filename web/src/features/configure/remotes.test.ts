import { describe, it, expect } from "vitest";
import {
  formatRemoteIdentity,
  identityFromEventRfId,
  REMOTE_BUTTON_LEGEND,
} from "./remotes";

describe("formatRemoteIdentity", () => {
  it("normalises to uppercase 5-digit hex with a 0x prefix", () => {
    expect(formatRemoteIdentity("0xe45ca")).toBe("0xE45CA");
    expect(formatRemoteIdentity("e45ca")).toBe("0xE45CA");
  });

  it("pads a short identity to 5 digits", () => {
    expect(formatRemoteIdentity("0x1a")).toBe("0x0001A");
  });
});

describe("identityFromEventRfId", () => {
  // The pairing UI reads unknown codes from /events, which carry the FULL
  // 24-bit code including the button nibble. The stored identity is the top
  // 20 bits, so every button of one remote must map to the same value.
  it("strips the button nibble so all buttons share one identity", () => {
    expect(identityFromEventRfId("0xE45CA2")).toBe("0xE45CA");
    expect(identityFromEventRfId("0xE45CA4")).toBe("0xE45CA");
    expect(identityFromEventRfId("0xE45CA8")).toBe("0xE45CA");
    expect(identityFromEventRfId("0xE45CA1")).toBe("0xE45CA");
  });

  it("returns null for a code it cannot parse", () => {
    expect(identityFromEventRfId("SIREN0")).toBeNull();
    expect(identityFromEventRfId("")).toBeNull();
  });
});

describe("REMOTE_BUTTON_LEGEND", () => {
  it("documents all four buttons, with S explicitly unused", () => {
    expect(REMOTE_BUTTON_LEGEND).toHaveLength(4);
    const s = REMOTE_BUTTON_LEGEND.find((b) => b.nibble === 0x1);
    expect(s?.action).toBe("Not used");
  });

  it("maps each nibble exactly once, matching remote_control.cpp", () => {
    const nibbles = REMOTE_BUTTON_LEGEND.map((b) => b.nibble).sort();
    expect(nibbles).toEqual([0x1, 0x2, 0x4, 0x8]);
  });
});
