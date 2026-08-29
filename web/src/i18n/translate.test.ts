import { describe, it, expect, vi, afterEach } from "vitest";
import { en } from "./en";
import { he } from "./he";
import { translate } from "./translate";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("translate", () => {
  it("returns the string for a known key", () => {
    expect(translate(en, "common.save")).toBe("Save");
  });

  it("interpolates a named placeholder", () => {
    expect(translate(en, "ops.alarmAt", { time: "14:05" })).toBe("at 14:05");
  });

  it("interpolates the same placeholder more than once", () => {
    const dict = { "x.y": "{a} and {a}" } as unknown as typeof en;
    expect(translate(dict, "x.y" as keyof typeof en, { a: "z" })).toBe("z and z");
  });

  it("interpolates several distinct placeholders", () => {
    expect(
      translate(en, "cfg.sensors.unpairImpact", { updates: 2, deletes: 1 })
    ).toContain("2 rule(s) will be updated and 1 rule(s) deleted");
  });

  it("accepts numbers as values", () => {
    expect(translate(en, "cfg.sensors.olderSensors", { count: 3 })).toBe(
      "Older sensors (3)"
    );
  });

  it("leaves an unmatched placeholder untouched rather than printing undefined", () => {
    expect(translate(en, "ops.alarmAt", {})).toBe("at {time}");
  });

  it("falls back to the key itself when the key is unknown", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(translate(en, "nope.missing" as keyof typeof en)).toBe("nope.missing");
  });

  it("warns once for an unknown key so it is noticed in development", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    translate(en, "also.missing" as keyof typeof en);
    expect(warn).toHaveBeenCalled();
  });
});

describe("locale parity", () => {
  // The Record<TranslationKey, string> type on `he` already enforces this at
  // compile time; this catches a drift that a cast or a stale build could hide.
  it("he defines every key that en does", () => {
    const missing = Object.keys(en).filter((k) => !(k in he));
    expect(missing).toEqual([]);
  });

  it("he defines no keys that en does not", () => {
    const extra = Object.keys(he).filter((k) => !(k in en));
    expect(extra).toEqual([]);
  });

  it("has no empty translations", () => {
    const empty = Object.entries(he)
      .filter(([, v]) => v.trim() === "")
      .map(([k]) => k);
    expect(empty).toEqual([]);
  });

  it("keeps every placeholder from en in the he translation", () => {
    const placeholders = (s: string) =>
      (s.match(/\{(\w+)\}/g) ?? []).sort().join(",");
    const mismatched = Object.entries(en)
      .filter(([k, v]) => placeholders(v) !== placeholders(he[k as keyof typeof en]))
      .map(([k]) => k);
    expect(mismatched).toEqual([]);
  });
});
