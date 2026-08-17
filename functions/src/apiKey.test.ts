import { describe, it, expect } from "vitest";
import { hashApiKey, apiKeyMatches } from "./apiKey";

describe("hashApiKey", () => {
  it("matches SHA-256 hex (same algorithm as the web)", () => {
    // echo -n "hello" | shasum -a 256
    expect(hashApiKey("hello")).toBe(
      "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"
    );
  });

  it("is deterministic", () => {
    expect(hashApiKey("abc123")).toBe(hashApiKey("abc123"));
  });
});

describe("apiKeyMatches", () => {
  const raw = "c2bd7db3dbae8005";
  const hash = hashApiKey(raw);

  it("accepts the correct key", () => {
    expect(apiKeyMatches(raw, hash)).toBe(true);
  });

  it("rejects a wrong key", () => {
    expect(apiKeyMatches("wrong", hash)).toBe(false);
  });

  it("rejects an empty key", () => {
    expect(apiKeyMatches("", hash)).toBe(false);
  });
});
