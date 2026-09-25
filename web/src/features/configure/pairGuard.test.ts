import { describe, it, expect } from "vitest";
import { isAlreadyPaired, sensorFamily } from "./pairGuard";

describe("sensorFamily", () => {
  it("prefers the stored familyId", () => {
    expect(sensorFamily({ familyId: "0x309A0", rfId: "0x309A0A" })).toBe(
      "0x309A0"
    );
  });

  it("canonicalises a lower-case stored familyId", () => {
    expect(sensorFamily({ familyId: "0x309a0", rfId: "0x309A0A" })).toBe(
      "0x309A0"
    );
  });

  it("derives the family when the field is absent (pre-migration docs)", () => {
    expect(sensorFamily({ rfId: "0xCC2682" })).toBe("0xCC268");
  });

  it("does not shift an already-shifted family a second time", () => {
    expect(sensorFamily({ familyId: "0x0061D", rfId: "0x0061DA" })).toBe(
      "0x0061D"
    );
  });

  it("returns null for an unparseable rfId with no stored family", () => {
    expect(sensorFamily({ rfId: "REMOTE" })).toBeNull();
  });
});

describe("isAlreadyPaired", () => {
  const sensors = [
    { familyId: "0xCC268", rfId: "0xCC2682" }, // smoke detector 1
    { familyId: "0x0061D", rfId: "0x0061DA" }, // motion
  ];

  it("is false for a genuinely new family", () => {
    // The real case: 0x309A0 is a DIFFERENT smoke detector to 0xCC268.
    expect(isAlreadyPaired("0x309A0A", sensors)).toBe(false);
  });

  it("is true for the exact code already paired", () => {
    expect(isAlreadyPaired("0xCC2682", sensors)).toBe(true);
  });

  it("is true for another code in a paired family", () => {
    // The tamper of an already-paired motion sensor is the same device.
    expect(isAlreadyPaired("0x0061DB", sensors)).toBe(true);
  });

  it("is false against an empty sensor list", () => {
    expect(isAlreadyPaired("0x309A0A", [])).toBe(false);
  });

  it("matches pre-migration docs that store no familyId", () => {
    expect(isAlreadyPaired("0xCC268F", [{ rfId: "0xCC2682" }])).toBe(true);
  });

  it("compares unparseable codes verbatim", () => {
    expect(isAlreadyPaired("REMOTE", [{ rfId: "REMOTE" }])).toBe(true);
    expect(isAlreadyPaired("REMOTE", sensors)).toBe(false);
  });
});
