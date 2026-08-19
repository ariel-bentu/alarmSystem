import { describe, it, expect } from "vitest";
import { hashApiKey } from "./apiKey";

// mintDeviceToken's HTTP handler wraps Firebase Admin calls (Firestore
// lookup, createCustomToken) that require the emulator to exercise
// end-to-end. This test covers the pure, emulator-free logic: that a
// correctly-hashed key produces the same hash the handler will look up.
// Full request/response behavior (400/401/404/200 paths) is covered by
// manual verification in Step 5, matching this project's existing coverage
// level for deviceIngest.ts (which also has no dedicated test file).
describe("mintDeviceToken key hashing", () => {
  it("hashes the same raw key deterministically, matching apiKey.ts", () => {
    const raw = "test-device-key-123";
    expect(hashApiKey(raw)).toBe(hashApiKey(raw));
    expect(hashApiKey(raw)).toHaveLength(64); // sha256 hex
  });
});
