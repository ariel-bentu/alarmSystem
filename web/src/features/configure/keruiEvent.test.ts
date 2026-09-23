import { describe, it, expect } from "vitest";
import {
  keruiEventOf,
  keruiEventLabel,
  familyIdOf,
  normaliseFamilyId,
  nibbleOf,
  eventOfRfId,
} from "./keruiEvent";

describe("keruiEventOf", () => {
  it("maps the three trigger nibbles", () => {
    expect(keruiEventOf(0xa)).toBe("trigger"); // motion
    expect(keruiEventOf(0xe)).toBe("trigger"); // door open
    // 0x9 is ours: curtain beam cut AND door-open on family 0x2E5B7.
    expect(keruiEventOf(0x9)).toBe("trigger");
  });

  it("maps both close nibbles", () => {
    expect(keruiEventOf(0x3)).toBe("close"); // ours
    expect(keruiEventOf(0x7)).toBe("close"); // rtl_433's
  });

  it("maps tamper, water and battery_low", () => {
    expect(keruiEventOf(0xb)).toBe("tamper");
    expect(keruiEventOf(0x5)).toBe("water");
    expect(keruiEventOf(0xf)).toBe("battery_low");
  });

  it("maps every other nibble to unknown", () => {
    for (const n of [0x0, 0x1, 0x2, 0x4, 0x6, 0x8, 0xc, 0xd]) {
      expect(keruiEventOf(n)).toBe("unknown");
    }
  });

  it("masks off bits above the nibble", () => {
    expect(keruiEventOf(0x1b)).toBe("tamper");
  });
});

describe("familyIdOf", () => {
  it("collapses a sensor's motion and tamper codes to one family", () => {
    expect(familyIdOf("0x0061DA")).toBe("0x0061D");
    expect(familyIdOf("0x0061DB")).toBe("0x0061D");
  });

  it("upper-cases and zero-pads to five digits", () => {
    expect(familyIdOf("0x00d91a")).toBe("0x00D91");
  });

  it("returns null for non-hex RTDB keys", () => {
    // /events holds non-sensor keys too, e.g. "REMOTE" from remote pairing.
    expect(familyIdOf("REMOTE")).toBeNull();
    expect(familyIdOf("")).toBeNull();
  });
});

describe("normaliseFamilyId", () => {
  it("canonicalises a value that is already a family", () => {
    expect(normaliseFamilyId("0x0061d")).toBe("0x0061D");
    expect(normaliseFamilyId("0x0061D")).toBe("0x0061D");
  });

  it("rejects a full 6-digit rfId, so callers cannot double-shift", () => {
    // Running familyIdOf on an already-shifted family turns "0x0061D" into
    // "0x00061" and matches nothing. Length is what tells the two apart.
    expect(normaliseFamilyId("0x0061DA")).toBeNull();
  });

  it("rejects non-hex keys", () => {
    expect(normaliseFamilyId("REMOTE")).toBeNull();
    expect(normaliseFamilyId("")).toBeNull();
  });
});

describe("nibbleOf / eventOfRfId", () => {
  it("extracts the nibble and names the event", () => {
    expect(nibbleOf("0x0061DB")).toBe(0xb);
    expect(eventOfRfId("0x0061DB")).toBe("tamper");
    expect(eventOfRfId("0x0061DA")).toBe("trigger");
    expect(eventOfRfId("0x2E5B73")).toBe("close");
  });

  it("calls an unparseable key unknown rather than throwing", () => {
    expect(eventOfRfId("REMOTE")).toBe("unknown");
  });
});

describe("keruiEventLabel", () => {
  it("labels every event", () => {
    expect(keruiEventLabel("trigger")).toBe("Trigger");
    expect(keruiEventLabel("close")).toBe("Close");
    expect(keruiEventLabel("tamper")).toBe("Tamper");
    expect(keruiEventLabel("water")).toBe("Water");
    expect(keruiEventLabel("battery_low")).toBe("Battery low");
    expect(keruiEventLabel("unknown")).toBe("Unknown");
  });
});
