import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  keruiEventOf,
  keruiEventName,
  familyIdOf,
  formatFamilyId,
  nibbleOf,
} from "./keruiEvent";

describe("keruiEventOf", () => {
  it("maps the three trigger nibbles", () => {
    // 0xA motion and 0xE door-open are rtl_433's, confirmed by our census.
    expect(keruiEventOf(0xa)).toBe("trigger");
    expect(keruiEventOf(0xe)).toBe("trigger");
    // 0x9 is ours: beam cut on four curtain sensors AND door-open on family
    // 0x2E5B7. Ambiguous as a TYPE, unambiguous as "primary alarm event".
    expect(keruiEventOf(0x9)).toBe("trigger");
  });

  it("maps both close nibbles", () => {
    // Two close codes, both real: 0x3 is this house's, 0x7 is rtl_433's.
    expect(keruiEventOf(0x3)).toBe("close");
    expect(keruiEventOf(0x7)).toBe("close");
  });

  it("maps tamper, water and battery_low", () => {
    expect(keruiEventOf(0xb)).toBe("tamper");
    expect(keruiEventOf(0x5)).toBe("water");
    expect(keruiEventOf(0xf)).toBe("battery_low");
  });

  it("maps every other nibble to unknown", () => {
    // 0x2 is the smoke detector's and has never fired in 3,089 events, so it
    // is unverified and deliberately not in the table.
    for (const n of [0x0, 0x1, 0x2, 0x4, 0x6, 0x8, 0xc, 0xd]) {
      expect(keruiEventOf(n)).toBe("unknown");
    }
  });

  it("masks off bits above the nibble", () => {
    expect(keruiEventOf(0x1b)).toBe("tamper");
    expect(keruiEventOf(0xfa)).toBe("trigger");
  });
});

describe("keruiEventName", () => {
  it("reports an unknown nibble as a trigger, never dropping it", () => {
    // The smoke detector's always-rule depends on this: a silently-ignored
    // smoke alarm is the worst outcome this refactor could produce.
    expect(keruiEventName("unknown")).toBe("trigger");
  });

  it("passes every known event through unchanged", () => {
    expect(keruiEventName("trigger")).toBe("trigger");
    expect(keruiEventName("close")).toBe("close");
    expect(keruiEventName("tamper")).toBe("tamper");
    expect(keruiEventName("water")).toBe("water");
    expect(keruiEventName("battery_low")).toBe("battery_low");
  });
});

describe("familyIdOf", () => {
  it("collapses a sensor's motion and tamper codes to one family", () => {
    // The whole design in one assertion. Today 0x0061DB matches no sensor
    // and is logged as unpaired, invisible to rules and alerts.
    expect(familyIdOf("0x0061DA")).toBe("0x0061D");
    expect(familyIdOf("0x0061DB")).toBe("0x0061D");
  });

  it("collapses the door sensor's open and close codes", () => {
    // Family 0x2E5B7 sends 0x3 (close, x40) and 0x9 (open, x12); it is
    // currently paired on the CLOSE code, so it alarms on the door SHUTTING.
    expect(familyIdOf("0x2E5B73")).toBe("0x2E5B7");
    expect(familyIdOf("0x2E5B79")).toBe("0x2E5B7");
  });

  it("upper-cases and zero-pads to five digits", () => {
    // The stored form must be canonical, because matching is a string
    // comparison on the device (strcmp, inside the RF path).
    expect(familyIdOf("0x00d91a")).toBe("0x00D91");
    expect(familyIdOf("0x0061dA")).toBe("0x0061D");
  });

  it("handles the real paired sensors from the live project", () => {
    expect(familyIdOf("0xCC2682")).toBe("0xCC268"); // smoke
    expect(familyIdOf("0x24B47E")).toBe("0x24B47");
    expect(familyIdOf("0x4D6A7E")).toBe("0x4D6A7");
  });

  it("returns null for unparseable keys rather than a bogus family", () => {
    // The simulator has written five-digit artefacts; a caller must be able
    // to tell a bad RTDB key from a real family.
    expect(familyIdOf("")).toBeNull();
    expect(familyIdOf("REMOTE")).toBeNull();
    expect(familyIdOf("0xZZZZZZ")).toBeNull();
    expect(familyIdOf("2E5B73")).toBeNull(); // no 0x prefix
  });

  it("accepts the short simulator code as a real (if odd) family", () => {
    // "0x11111" is 5 digits, not 6 — it parses, and shifting gives 0x01111.
    // Deliberately NOT special-cased: it is a valid hex value and pretending
    // otherwise would hide simulator traffic rather than show it.
    expect(familyIdOf("0x11111")).toBe("0x01111");
  });
});

describe("formatFamilyId", () => {
  it("renders a numeric family in the canonical stored form", () => {
    expect(formatFamilyId(0x0061d)).toBe("0x0061D");
    expect(formatFamilyId(0x2e5b7)).toBe("0x2E5B7");
  });

  it("masks to 20 bits", () => {
    expect(formatFamilyId(0xfffffff)).toBe("0xFFFFF");
  });
});

describe("nibbleOf", () => {
  it("extracts the event nibble", () => {
    expect(nibbleOf("0x0061DA")).toBe(0xa);
    expect(nibbleOf("0x0061DB")).toBe(0xb);
    expect(nibbleOf("0x2E5B73")).toBe(0x3);
    expect(nibbleOf("0xCC2682")).toBe(0x2);
  });

  it("returns null for unparseable keys", () => {
    expect(nibbleOf("REMOTE")).toBeNull();
  });
});

// The table is duplicated in three languages on purpose (no shared module).
// This test is what keeps the duplication honest: it reads the firmware
// header and the web module as TEXT and asserts every nibble agrees with
// this file's. A drift fails here rather than on hardware.
describe("cross-layer table agreement", () => {
  const ALL_NIBBLES = [
    0x0, 0x1, 0x2, 0x3, 0x4, 0x5, 0x6, 0x7, 0x8, 0x9, 0xa, 0xb, 0xc, 0xd, 0xe,
    0xf,
  ];

  it("matches the firmware's kerui_event.h, nibble by nibble", () => {
    const src = readFileSync(
      resolve(__dirname, "../../firmware/edge/device/src/kerui_event.h"),
      "utf8"
    );
    // Parse the switch: `case 0xN:` lines accumulate until a `return
    // KeruiEvent::X;`, which assigns X to all of them.
    const firmware = new Map<number, string>();
    let pending: number[] = [];
    for (const line of src.split("\n")) {
      const caseMatch = line.match(/^\s*case 0x([0-9A-Fa-f]):/);
      if (caseMatch) {
        pending.push(parseInt(caseMatch[1], 16));
        continue;
      }
      const returnMatch = line.match(/^\s*return KeruiEvent::([A-Z_]+);/);
      if (returnMatch && pending.length > 0) {
        for (const n of pending) firmware.set(n, returnMatch[1].toLowerCase());
        pending = [];
      }
    }
    // Sanity: the parse must actually have found the table, or this test
    // would pass vacuously after a refactor renamed the enum.
    expect(firmware.size).toBe(8);

    for (const n of ALL_NIBBLES) {
      expect(firmware.get(n) ?? "unknown").toBe(keruiEventOf(n));
    }
  });

  it("matches the web's keruiEvent.ts, nibble by nibble", () => {
    const src = readFileSync(
      resolve(__dirname, "../../web/src/features/configure/keruiEvent.ts"),
      "utf8"
    );
    const web = new Map<number, string>();
    for (const line of src.split("\n")) {
      const m = line.match(/^\s*0x([0-9a-fA-F]):\s*"([a-z_]+)",/);
      if (m) web.set(parseInt(m[1], 16), m[2]);
    }
    expect(web.size).toBe(8);

    for (const n of ALL_NIBBLES) {
      expect(web.get(n) ?? "unknown").toBe(keruiEventOf(n));
    }
  });
});
