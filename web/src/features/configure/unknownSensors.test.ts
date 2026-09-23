import { describe, it, expect } from "vitest";
import { getUnknownRfIds } from "./unknownSensors";

describe("getUnknownRfIds", () => {
  it("returns empty array when there are no event rfIds", () => {
    expect(getUnknownRfIds([], ["0xA1B2C3"])).toEqual([]);
  });

  it("returns empty array when all event rfIds are known", () => {
    const eventRfIds = ["0xA1B2C3", "0xD4E5F6"];
    const knownRfIds = ["0xA1B2C3", "0xD4E5F6"];
    expect(getUnknownRfIds(eventRfIds, knownRfIds)).toEqual([]);
  });

  it("returns rfIds not present in knownRfIds", () => {
    const eventRfIds = ["0xA1B2C3", "0xD4E5F6", "0x111111"];
    const knownRfIds = ["0xA1B2C3"];
    expect(getUnknownRfIds(eventRfIds, knownRfIds)).toEqual([
      "0xD4E5F6",
      "0x111111",
    ]);
  });

  it("deduplicates unknown rfIds", () => {
    const eventRfIds = ["0xAABBCC", "0xAABBCC", "0xAABBCC"];
    const knownRfIds: string[] = [];
    expect(getUnknownRfIds(eventRfIds, knownRfIds)).toEqual(["0xAABBCC"]);
  });

  it("handles empty known list — all events are unknown", () => {
    const eventRfIds = ["0x111111", "0x222222"];
    expect(getUnknownRfIds(eventRfIds, [])).toEqual(["0x111111", "0x222222"]);
  });

  it("preserves order of first occurrence", () => {
    const eventRfIds = ["0xBBBBBB", "0xAAAAAA", "0xBBBBBB"];
    expect(getUnknownRfIds(eventRfIds, [])).toEqual(["0xBBBBBB", "0xAAAAAA"]);
  });
});

describe("getUnknownRfIds — family matching", () => {
  it("does not list a tamper code whose sensor is already paired", () => {
    // THE case this change exists for. 0x0061DA (motion) is paired;
    // 0x0061DB (tamper) is the SAME physical sensor. It used to appear here
    // as an unrecognised sensor, which is also why it was invisible to every
    // rule and alert.
    expect(getUnknownRfIds(["0x0061DB"], ["0x0061DA"])).toEqual([]);
  });

  it("does not list the door sensor's open code when paired on close", () => {
    // Family 0x2E5B7 is paired as 0x2E5B73 (close); its opens are 0x2E5B79.
    expect(getUnknownRfIds(["0x2E5B79"], ["0x2E5B73"])).toEqual([]);
  });

  it("still lists a genuinely unpaired family", () => {
    expect(getUnknownRfIds(["0x3F0102"], ["0x0061DA"])).toEqual(["0x3F0102"]);
  });

  it("accepts stored familyIds in the known list", () => {
    // Callers may hold either form; both reduce to the same family.
    expect(getUnknownRfIds(["0x0061DB"], ["0x0061D"])).toEqual([]);
  });

  it("returns the full observed CODE, not the family", () => {
    // The event code is the information the pairing UI shows — collapsing it
    // to a family would destroy the distinction the whole design rests on.
    expect(getUnknownRfIds(["0x3F0102"], [])).toEqual(["0x3F0102"]);
  });

  it("dedupes several codes from one unpaired family to the first seen", () => {
    // A new sensor sending motion then tamper is ONE thing to pair, listed
    // once, under the first code heard.
    expect(getUnknownRfIds(["0x3F010A", "0x3F010B", "0x3F010A"], [])).toEqual([
      "0x3F010A",
    ]);
  });

  it("compares non-hex RTDB keys verbatim rather than swallowing them", () => {
    // /events also holds "SIREN0" and "REMOTE"; neither has a family, and
    // hiding them would make them invisible to whoever reads this list.
    expect(getUnknownRfIds(["SIREN0", "REMOTE"], [])).toEqual([
      "SIREN0",
      "REMOTE",
    ]);
    expect(getUnknownRfIds(["SIREN0"], ["SIREN0"])).toEqual([]);
  });
});
