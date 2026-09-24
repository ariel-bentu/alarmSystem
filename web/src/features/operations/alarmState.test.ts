import { describe, it, expect } from "vitest";
import {
  alarmSide,
  causeLabel,
  isAlarmActive,
  parseAlarmCause,
} from "./alarmState";

describe("parseAlarmCause", () => {
  it("parses a device-written cause", () => {
    expect(parseAlarmCause({ rfId: "0x2E5B73", ct: 0, at: 123 })).toEqual({
      rfId: "0x2E5B73",
      ct: 0,
      at: 123,
    });
  });

  it("parses a server-written cause", () => {
    expect(parseAlarmCause({ label: "Night watch", at: 123 })).toEqual({
      label: "Night watch",
      at: 123,
    });
  });

  it("returns null for a missing or non-object value", () => {
    expect(parseAlarmCause(null)).toBeNull();
    expect(parseAlarmCause(undefined)).toBeNull();
    expect(parseAlarmCause("boom")).toBeNull();
  });

  it("drops fields of the wrong type rather than throwing", () => {
    expect(parseAlarmCause({ rfId: 7, at: "soon" })).toEqual({});
  });
});

describe("alarmSide", () => {
  it("attributes a cause carrying rfId to the device", () => {
    expect(alarmSide({ rfId: "0x2E5B73", at: 1 })).toBe("device");
  });

  it("attributes a cause carrying a label to the server", () => {
    expect(alarmSide({ label: "Night watch", at: 1 })).toBe("server");
  });

  it("prefers device when a cause somehow carries both", () => {
    expect(alarmSide({ rfId: "0x2E5B73", label: "x", at: 1 })).toBe("device");
  });

  it("returns null when the cause identifies neither", () => {
    expect(alarmSide({ at: 1 })).toBeNull();
  });
});

describe("isAlarmActive", () => {
  const cause = { rfId: "0x2E5B73", at: 5000 };

  it("is active when the cause is newer than the acknowledgement", () => {
    expect(isAlarmActive(cause, 4000)).toBe(true);
  });

  it("is inactive once acknowledged at the same timestamp", () => {
    expect(isAlarmActive(cause, 5000)).toBe(false);
  });

  it("is inactive when acknowledged later", () => {
    expect(isAlarmActive(cause, 6000)).toBe(false);
  });

  it("is active when nothing has been acknowledged yet", () => {
    expect(isAlarmActive(cause, null)).toBe(true);
  });

  it("is inactive when there is no cause", () => {
    expect(isAlarmActive(null, null)).toBe(false);
  });

  it("is inactive when the cause has no timestamp", () => {
    expect(isAlarmActive({ rfId: "0x2E5B73" }, null)).toBe(false);
  });
});

describe("causeLabel", () => {
  const sensorNames = { "0x2E5B73": "Front door" };

  it("uses the server label verbatim", () => {
    expect(causeLabel({ label: "Night watch", at: 1 }, sensorNames)).toBe(
      "Night watch"
    );
  });

  it("resolves a device rfId to its sensor name", () => {
    expect(causeLabel({ rfId: "0x2E5B73", at: 1 }, sensorNames)).toBe(
      "Front door"
    );
  });

  it("falls back to the raw rfId for an unpaired sensor", () => {
    expect(causeLabel({ rfId: "0xFFFFFF", at: 1 }, sensorNames)).toBe("0xFFFFFF");
  });

  it("returns null when the cause identifies nothing", () => {
    expect(causeLabel({ at: 1 }, sensorNames)).toBeNull();
  });

  it("ignores a blank label and falls through to rfId", () => {
    expect(causeLabel({ label: "  ", rfId: "0x2E5B73", at: 1 }, sensorNames)).toBe(
      "Front door"
    );
  });

  // The device writes the 20-bit FAMILY as the cause (alarm rules match on
  // the family), while the sensor map is keyed by the full 24-bit rfId. An
  // exact lookup misses and the banner showed a bare "0x4D6A7".
  it("resolves a device-written FAMILY to its sensor name", () => {
    expect(causeLabel({ rfId: "0x2E5B7", at: 1 }, sensorNames)).toBe(
      "Front door"
    );
  });

  it("matches the family case-insensitively", () => {
    expect(causeLabel({ rfId: "0x2e5b7", at: 1 }, sensorNames)).toBe(
      "Front door"
    );
  });

  it("falls back to the raw family when no sensor shares it", () => {
    expect(causeLabel({ rfId: "0xABCDE", at: 1 }, sensorNames)).toBe("0xABCDE");
  });
});
