import { describe, it, expect } from "vitest";
import { generateApiKey, hashApiKey } from "./apiKey";

describe("generateApiKey", () => {
  it("returns a 64-character hex string", () => {
    const key = generateApiKey();
    expect(key).toMatch(/^[0-9a-f]{64}$/);
  });

  it("generates unique keys on successive calls", () => {
    const keys = new Set(Array.from({ length: 20 }, () => generateApiKey()));
    expect(keys.size).toBe(20);
  });
});

describe("hashApiKey", () => {
  it("returns a 64-character hex string (SHA-256)", async () => {
    const hash = await hashApiKey("test-key");
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is deterministic for the same input", async () => {
    const h1 = await hashApiKey("my-secret");
    const h2 = await hashApiKey("my-secret");
    expect(h1).toBe(h2);
  });

  it("produces different hashes for different inputs", async () => {
    const h1 = await hashApiKey("key-a");
    const h2 = await hashApiKey("key-b");
    expect(h1).not.toBe(h2);
  });

  it("matches known SHA-256 for empty string", async () => {
    // SHA-256("") = e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
    const hash = await hashApiKey("");
    expect(hash).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    );
  });
});
