import { describe, it, expect } from "vitest";
import { eventSubject } from "./eventSubject";

// A minimal stand-in for the real t(): returns the key so assertions can see
// exactly which translation was chosen, and interpolates {name} like the real
// one does.
const t = (key: string, vars?: Record<string, string | number>) =>
  vars ? `${key}(${Object.values(vars).join(",")})` : key;

describe("eventSubject", () => {
  it("prefixes a remote arm/disarm with the translated 'remote' word", () => {
    // The name comes from Firestore and is language-neutral; the prefix is
    // added here so Hebrew reads "שלט <name>" and English "Remote <name>".
    expect(eventSubject("disarmed", "Front door fob", t, "remote")).toBe(
      "explore.remoteSubject(Front door fob)"
    );
    expect(eventSubject("armed", "Front door fob", t, "remote")).toBe(
      "explore.remoteSubject(Front door fob)"
    );
  });

  it("does not prefix the generic Device label", () => {
    // armEventSourceLabel() writes "Device" for a local/cloud arm — calling
    // that "Remote Device" would be actively wrong.
    expect(eventSubject("disarmed", "Device", t, "local")).toBe("Device");
  });

  it("does not double-prefix the generic Remote fallback", () => {
    // An unpaired identity falls back to the literal "Remote"; prefixing it
    // would read "Remote Remote".
    expect(eventSubject("disarmed", "Remote", t, "remote")).toBe(
      "explore.eventSource.remote"
    );
  });

  // The bug this file exists to pin: onArmStateChange writes the PROFILE name
  // into the same sensorName field that onDeviceArmStateChange uses for a
  // remote's name. Without an explicit source, arming from the app under
  // profile "Night" rendered as "Remote Night" — inventing a remote.
  it("names the cloud source instead of claiming a remote", () => {
    expect(eventSubject("armed", "Night", t, "app")).toBe(
      "explore.armSubject(explore.eventSource.app,Night)"
    );
    expect(eventSubject("armed", "Night", t, "schedule")).toBe(
      "explore.armSubject(explore.eventSource.schedule,Night)"
    );
    expect(eventSubject("armed", "Night", t, "telegram")).toBe(
      "explore.armSubject(explore.eventSource.telegram,Night)"
    );
  });

  it("shows the bare source word when no profile was recorded", () => {
    // A disarm carries no profile, and onArmStateChange stores "" for it.
    // Joining that would render a dangling "App — ".
    expect(eventSubject("disarmed", "", t, "app")).toBe(
      "explore.eventSource.app"
    );
    expect(eventSubject("disarmed", "", t, "schedule")).toBe(
      "explore.eventSource.schedule"
    );
  });

  it("leaves a historical row unprefixed rather than guessing", () => {
    // Rows written before armSource existed carry either a profile name or a
    // remote name with nothing to tell them apart. Showing the name plain is
    // the only option that never claims a remote it cannot prove.
    expect(eventSubject("armed", "Night", t)).toBe("Night");
    expect(eventSubject("disarmed", "Front door fob", t)).toBe(
      "Front door fob"
    );
    // The generic literals are still worth translating/passing through.
    expect(eventSubject("disarmed", "Remote", t)).toBe(
      "explore.eventSource.remote"
    );
    expect(eventSubject("disarmed", "Device", t)).toBe("Device");
  });

  it("translates a restart reason instead of showing the raw code", () => {
    // The reason is stored raw (power_on, twdt, ...) to keep the database
    // language-neutral; the UI owns the mapping via bootReasonKey().
    expect(eventSubject("device_restart", "power_on", t)).toBe(
      "ops.bootPowerOn"
    );
    expect(eventSubject("device_restart", "twdt", t)).toBe("ops.bootWatchdog");
    expect(eventSubject("device_restart", "panic", t)).toBe("ops.bootPanic");
  });

  it("falls back to a readable string for an unrecognised restart reason", () => {
    // A future firmware reason must not render as a blank cell.
    expect(eventSubject("device_restart", "something_new", t)).toBe(
      "ops.bootUnknown"
    );
    expect(eventSubject("device_restart", "", t)).toBe("ops.bootUnknown");
  });

  it("passes other event subjects through untouched", () => {
    // Sensor names and the offline/online descriptions are already display
    // text and must not be rewritten.
    expect(eventSubject("trigger", "Kitchen PIR", t)).toBe("Kitchen PIR");
    expect(eventSubject("device_offline", "Offline 6m while armed", t)).toBe(
      "Offline 6m while armed"
    );
    expect(eventSubject("alarm", "SOS (remote)", t)).toBe("SOS (remote)");
  });

  it("returns empty for an empty subject so the caller can show 'System'", () => {
    expect(eventSubject("alarm", "", t)).toBe("");
  });
});
