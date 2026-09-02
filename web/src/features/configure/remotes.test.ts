import { describe, it, expect } from "vitest";
import {
  formatRemoteIdentity,
  identityFromEventRfId,
  groupCandidatesByIdentity,
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

describe("groupCandidatesByIdentity", () => {
  const timing = {
    "0xE45CA2": { firstSeen: 100, lastSeen: 500, count: 2 },
    "0xE45CA4": { firstSeen: 200, lastSeen: 900, count: 3 },
    "0x170D09": { firstSeen: 50, lastSeen: 60, count: 1 },
    SIREN0: { firstSeen: 1, lastSeen: 2, count: 1 },
  };

  it("collapses every button of one remote onto a single candidate", () => {
    const out = groupCandidatesByIdentity(timing, []);
    const e45 = out.find((c) => c.identity === "0xE45CA");
    expect(e45).toBeDefined();
    // Two buttons seen, so both codes are listed against the one remote.
    expect(e45?.codes.sort()).toEqual(["0xE45CA2", "0xE45CA4"]);
  });

  it("sums event counts and takes the newest sighting across buttons", () => {
    const e45 = groupCandidatesByIdentity(timing, []).find(
      (c) => c.identity === "0xE45CA"
    );
    expect(e45?.count).toBe(5); // 2 + 3
    expect(e45?.lastSeen).toBe(900); // newest of 500 / 900
  });

  it("drops identities already paired", () => {
    const out = groupCandidatesByIdentity(timing, ["0xE45CA"]);
    expect(out.find((c) => c.identity === "0xE45CA")).toBeUndefined();
    expect(out.find((c) => c.identity === "0x170D0")).toBeDefined();
  });

  it("ignores non-hex pseudo-sensors like SIREN0", () => {
    const out = groupCandidatesByIdentity(timing, []);
    expect(out.some((c) => c.codes.includes("SIREN0"))).toBe(false);
  });

  it("orders most recently seen first", () => {
    const out = groupCandidatesByIdentity(timing, []);
    expect(out[0].identity).toBe("0xE45CA"); // lastSeen 900 beats 60
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
