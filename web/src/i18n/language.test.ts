import { describe, it, expect } from "vitest";
import { isLanguage, resolveInitialLanguage } from "./language";

describe("isLanguage", () => {
  it("accepts the supported codes", () => {
    expect(isLanguage("en")).toBe(true);
    expect(isLanguage("he")).toBe(true);
  });

  it("rejects anything else", () => {
    expect(isLanguage("fr")).toBe(false);
    expect(isLanguage("")).toBe(false);
    expect(isLanguage(null)).toBe(false);
    expect(isLanguage(undefined)).toBe(false);
  });
});

describe("resolveInitialLanguage", () => {
  it("prefers a stored choice over the browser", () => {
    expect(resolveInitialLanguage("he", ["en-US"])).toBe("he");
    expect(resolveInitialLanguage("en", ["he-IL"])).toBe("en");
  });

  it("ignores a corrupt stored value and falls back to the browser", () => {
    expect(resolveInitialLanguage("klingon", ["he-IL"])).toBe("he");
  });

  it("uses Hebrew when the browser prefers it", () => {
    expect(resolveInitialLanguage(null, ["he-IL", "en-US"])).toBe("he");
  });

  it("matches a bare 'he' without a region", () => {
    expect(resolveInitialLanguage(null, ["he"])).toBe("he");
  });

  it("is case-insensitive about browser tags", () => {
    expect(resolveInitialLanguage(null, ["HE-IL"])).toBe("he");
  });

  it("honours the browser's ORDER of preference", () => {
    expect(resolveInitialLanguage(null, ["en-GB", "he-IL"])).toBe("en");
    expect(resolveInitialLanguage(null, ["he-IL", "en-GB"])).toBe("he");
  });

  it("defaults to English for unsupported languages", () => {
    expect(resolveInitialLanguage(null, ["fr-FR", "de-DE"])).toBe("en");
  });

  it("defaults to English when the browser reports nothing", () => {
    expect(resolveInitialLanguage(null, [])).toBe("en");
  });
});
