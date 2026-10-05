// Whether a sensor-doc write changes anything the DEVICE config carries.
//
// This guard exists because of a trap documented in CLAUDE.md: RTDB
// /{projectId}/config is DERIVED state, and for a long time no sensor write
// rebuilt it — only profile/rule/remote/project-config triggers did. So a
// field the device reads from a SENSOR doc (its camera selection) could be
// edited in the web UI and never reach the device.
import { describe, it, expect } from "vitest";
import { sensorConfigChanged } from "./sensorConfigChanged";

describe("sensorConfigChanged", () => {
  it("is true when the camera selection changes", () => {
    expect(
      sensorConfigChanged({ cameras: [1] }, { cameras: [1, 2] })
    ).toBe(true);
  });

  it("is true when cameras are cleared", () => {
    expect(sensorConfigChanged({ cameras: [1] }, { cameras: [] })).toBe(true);
  });

  it("is true when a sensor first gains a camera", () => {
    expect(sensorConfigChanged({}, { cameras: [3] })).toBe(true);
  });

  it("is true when the family id changes (r[] is keyed by it)", () => {
    expect(
      sensorConfigChanged({ familyId: "0x0061D" }, { familyId: "0x0072E" })
    ).toBe(true);
  });

  it("is true when the rfId changes (the family is derived from it)", () => {
    expect(
      sensorConfigChanged({ rfId: "0x0061DA" }, { rfId: "0x0072EA" })
    ).toBe(true);
  });

  it("ignores channel ORDER, which the mask cannot represent", () => {
    // A reordered array is the same mask, so rebuilding would be a pointless
    // RTDB write on every UI toggle that happens to reorder.
    expect(
      sensorConfigChanged({ cameras: [2, 1] }, { cameras: [1, 2] })
    ).toBe(false);
  });

  it("ignores duplicate entries, which the mask also collapses", () => {
    expect(
      sensorConfigChanged({ cameras: [1, 1] }, { cameras: [1] })
    ).toBe(false);
  });

  it("is false for fields the device config never carries", () => {
    // A rename or a battery-change date must NOT cost an RTDB config rebuild:
    // the device polls this config every 5s and does not know sensor names.
    expect(
      sensorConfigChanged(
        { name: "Kitchen", cameras: [1] },
        { name: "Hallway", cameras: [1] }
      )
    ).toBe(false);
  });

  it("is false when nothing changed at all", () => {
    expect(
      sensorConfigChanged({ cameras: [1], name: "A" }, { cameras: [1], name: "A" })
    ).toBe(false);
  });

  it("treats a created or deleted sensor as a change", () => {
    // Pairing or unpairing changes r[] itself.
    expect(sensorConfigChanged(undefined, { cameras: [1] })).toBe(true);
    expect(sensorConfigChanged({ cameras: [1] }, undefined)).toBe(true);
  });

  it("is false when a non-config field changes on a camera-less sensor", () => {
    expect(
      sensorConfigChanged({ name: "A" }, { name: "B" })
    ).toBe(false);
  });

  // definiteBreach became device-visible when the siren gained a hold for
  // non-definite sensors: the DEVICE decides whether to delay the siren, so
  // it must learn the flag. Previously excluded deliberately (certainty was a
  // cloud-only notification concern) — without this the hold would never
  // reach the device, the derived-state trap that cost the camera selection
  // a release.
  it("is true when definiteBreach changes", () => {
    expect(
      sensorConfigChanged(
        { cameras: [1], definiteBreach: true },
        { cameras: [1], definiteBreach: false }
      )
    ).toBe(true);
  });

  // Absent means DEFINITE (breachCertainty.isDefiniteBreach owns that
  // default), so absent -> true is not a change the device can observe and
  // must not churn the config it polls every 5s.
  it("treats an absent definiteBreach as equivalent to true", () => {
    expect(
      sensorConfigChanged({ cameras: [1] }, { cameras: [1], definiteBreach: true })
    ).toBe(false);
    expect(
      sensorConfigChanged({ cameras: [1], definiteBreach: true }, { cameras: [1] })
    ).toBe(false);
  });

  it("is true when a sensor first becomes non-definite", () => {
    expect(
      sensorConfigChanged({ cameras: [1] }, { cameras: [1], definiteBreach: false })
    ).toBe(true);
  });
});
