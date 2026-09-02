import { describe, it, expect } from "vitest";
import { bootSeverity, bootReasonKey, isRecentBoot } from "./bootReason";

describe("bootSeverity", () => {
  it("treats human-initiated starts as normal", () => {
    expect(bootSeverity("power_on")).toBe("normal");
    expect(bootSeverity("external")).toBe("normal");
    expect(bootSeverity("sw_restart")).toBe("normal");
  });

  it("flags self-inflicted reboots as unexpected", () => {
    expect(bootSeverity("panic")).toBe("unexpected");
    expect(bootSeverity("twdt")).toBe("unexpected");
    expect(bootSeverity("brownout")).toBe("unexpected");
  });

  it("treats a missing reason as normal rather than alarming", () => {
    expect(bootSeverity(undefined)).toBe("normal");
  });

  it("treats an unrecognised reason as unexpected", () => {
    // Fail loud: a reason we do not know about is more likely a new fault
    // mode than a new benign one.
    expect(bootSeverity("something_new")).toBe("unexpected");
  });
});

describe("bootReasonKey", () => {
  it("distinguishes a crash from a freeze from a power dip", () => {
    expect(bootReasonKey("panic")).toBe("ops.bootPanic");
    expect(bootReasonKey("twdt")).toBe("ops.bootWatchdog");
    expect(bootReasonKey("brownout")).toBe("ops.bootBrownout");
  });

  it("maps every watchdog variant to one key", () => {
    expect(bootReasonKey("int_wdt")).toBe("ops.bootWatchdog");
    expect(bootReasonKey("other_wdt")).toBe("ops.bootWatchdog");
  });

  it("falls back to a generic key for an unknown reason", () => {
    expect(bootReasonKey("weird")).toBe("ops.bootUnknown");
    expect(bootReasonKey(undefined)).toBe("ops.bootUnknown");
  });
});

describe("isRecentBoot", () => {
  const NOW = 1_788_240_741_000;
  const WINDOW = 60 * 60 * 1000;

  it("accepts a boot inside the window", () => {
    expect(isRecentBoot({ reason: "panic", at: NOW - 1000 }, NOW, WINDOW)).toBe(
      true
    );
  });

  it("rejects a boot older than the window", () => {
    // The node persists until the next boot overwrites it, so without this
    // an old crash would banner forever.
    expect(
      isRecentBoot({ reason: "panic", at: NOW - WINDOW - 1 }, NOW, WINDOW)
    ).toBe(false);
  });

  it("rejects a pre-NTP timestamp as undatable", () => {
    // The device reports time(nullptr) which is epoch-adjacent before NTP
    // syncs; such a value cannot be compared against Date.now().
    expect(isRecentBoot({ reason: "panic", at: 12_000 }, NOW, WINDOW)).toBe(
      false
    );
  });

  it("rejects missing or malformed records", () => {
    expect(isRecentBoot(null, NOW, WINDOW)).toBe(false);
    expect(isRecentBoot(undefined, NOW, WINDOW)).toBe(false);
    expect(
      isRecentBoot({ reason: "panic" } as never, NOW, WINDOW)
    ).toBe(false);
  });

  it("rejects a boot timestamped in the future", () => {
    expect(isRecentBoot({ reason: "panic", at: NOW + 5000 }, NOW, WINDOW)).toBe(
      false
    );
  });
});
