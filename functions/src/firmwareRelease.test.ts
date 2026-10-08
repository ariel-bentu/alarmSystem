import { describe, it, expect } from "vitest";
import { firmwareObjectPath, publishBlocker, MAX_IMAGE_BYTES } from "./firmwareRelease";

const base = {
  version: "2026.10.08-1432-abc1234",
  size: 1_100_000,
  currentLatest: "2026.10.01-0900-0000000",
  allowDirty: false,
  force: false,
};

describe("firmwareObjectPath", () => {
  it("places the image under the device-readable firmware/ prefix", () => {
    expect(firmwareObjectPath("v1")).toBe("firmware/v1/firmware.bin");
  });
});

describe("publishBlocker", () => {
  it("allows a clean, newer build", () => {
    expect(publishBlocker(base)).toBeNull();
  });

  it("allows the very first release", () => {
    expect(publishBlocker({ ...base, currentLatest: null })).toBeNull();
  });

  it("refuses a dirty build unless explicitly allowed", () => {
    const dirty = { ...base, version: `${base.version}-dirty` };
    expect(publishBlocker(dirty)).toMatch(/uncommitted/);
    expect(publishBlocker({ ...dirty, allowDirty: true })).toBeNull();
  });

  it("refuses a version that would not be offered as an update", () => {
    expect(publishBlocker({ ...base, currentLatest: base.version })).toMatch(/does not sort after/);
    expect(publishBlocker({ ...base, currentLatest: "2027.01.01-0000-0000000" })).toMatch(
      /does not sort after/
    );
    expect(publishBlocker({ ...base, currentLatest: base.version, force: true })).toBeNull();
  });

  it("refuses an image that cannot fit the app slot", () => {
    expect(publishBlocker({ ...base, size: MAX_IMAGE_BYTES + 1 })).toMatch(/app slot/);
    expect(publishBlocker({ ...base, size: 0 })).toMatch(/empty/);
  });

  it("refuses characters the device would reject", () => {
    expect(publishBlocker({ ...base, version: "v1/../x" })).toMatch(/unsafe/);
  });
});
