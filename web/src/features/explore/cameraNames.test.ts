// Camera channel names: the label fallback and the save-time normalization.
// Pure, so these run without mounting the gallery or touching Firestore —
// same reasoning as batteryAge.test.ts beside it.
import { describe, it, expect } from "vitest";
import {
  ALL_CHANNELS,
  cameraLabel,
  cameraListLabel,
  normalizeCameraNames,
} from "./cameraNames";

describe("cameraLabel", () => {
  it("returns the stored name for a named channel", () => {
    expect(cameraLabel({ "1": "Front door" }, 1)).toBe("Front door");
  });

  it("falls back to Camera N when the channel has no name", () => {
    expect(cameraLabel({ "1": "Front door" }, 3)).toBe("Camera 3");
    expect(cameraLabel(undefined, 2)).toBe("Camera 2");
  });

  it("treats a blank or whitespace-only name as unnamed", () => {
    expect(cameraLabel({ "4": "   " }, 4)).toBe("Camera 4");
  });

  it("trims surrounding whitespace off a stored name", () => {
    expect(cameraLabel({ "5": "  Garage  " }, 5)).toBe("Garage");
  });
});

describe("cameraListLabel", () => {
  it("joins channels in channel order regardless of input order", () => {
    const names = { "1": "Front door", "3": "Back yard" };
    expect(cameraListLabel(names, [3, 1])).toBe("Front door, Back yard");
  });

  it("mixes named and unnamed channels", () => {
    expect(cameraListLabel({ "1": "Front door" }, [1, 2])).toBe(
      "Front door, Camera 2"
    );
  });

  it("names the empty selection rather than returning an empty string", () => {
    // SensorsTab renders this as the summary line for a sensor that captures
    // nothing, so it has to read as a deliberate state.
    expect(cameraListLabel({}, [])).toBe("No cameras");
  });
});

describe("normalizeCameraNames", () => {
  it("keeps trimmed names for in-range channels", () => {
    expect(normalizeCameraNames({ "1": "  Front door " })).toEqual({
      "1": "Front door",
    });
  });

  it("drops blank entries so a cleared input removes the name", () => {
    // Firestore would otherwise keep an empty string, and cameraLabel would
    // have to treat "" as unnamed forever.
    expect(normalizeCameraNames({ "1": "Front door", "2": "   " })).toEqual({
      "1": "Front door",
    });
  });

  it("drops channels outside 1-8", () => {
    expect(
      normalizeCameraNames({ "0": "zero", "9": "nine", "3": "Back yard" })
    ).toEqual({ "3": "Back yard" });
  });

  it("drops non-string values and non-numeric keys", () => {
    expect(
      normalizeCameraNames({ "1": 42, nope: "x", "2": "Driveway" })
    ).toEqual({ "2": "Driveway" });
  });

  it("caps a pasted essay so it cannot break a caption or tab strip", () => {
    const long = "x".repeat(200);
    const out = normalizeCameraNames({ "1": long });
    expect(out["1"].length).toBe(40);
  });

  it("returns an empty map for junk input", () => {
    expect(normalizeCameraNames(undefined)).toEqual({});
    expect(normalizeCameraNames("nope")).toEqual({});
  });
});

describe("ALL_CHANNELS", () => {
  it("lists the eight NVR channels in order", () => {
    expect(ALL_CHANNELS).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });
});
