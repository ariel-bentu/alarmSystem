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
