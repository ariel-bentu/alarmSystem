import { describe, it, expect } from "vitest";
import { parseSnapshotPath } from "./snapshotPath";

describe("parseSnapshotPath", () => {
  it("parses a valid snapshot object path", () => {
    expect(parseSnapshotPath("proj1/snapshots/0x2E5B73/1696000000/ch2.jpg")).toEqual({
      projectId: "proj1",
      rfId: "0x2E5B73",
      ts: 1696000000,
      channel: 2,
    });
  });

  it("rejects non-snapshot paths", () => {
    expect(parseSnapshotPath("proj1/other/x.jpg")).toBeNull();
  });

  it("rejects the wrong extension", () => {
    expect(parseSnapshotPath("proj1/snapshots/0x2E5B73/1696000000/ch2.png")).toBeNull();
  });

  it("rejects a path missing segments", () => {
    expect(parseSnapshotPath("proj1/snapshots/0x2E5B73/ch2.jpg")).toBeNull();
  });

  it("rejects a non-numeric timestamp", () => {
    expect(parseSnapshotPath("proj1/snapshots/0x2E5B73/notanumber/ch2.jpg")).toBeNull();
  });

  it("rejects a malformed channel segment", () => {
    expect(parseSnapshotPath("proj1/snapshots/0x2E5B73/1696000000/channel2.jpg")).toBeNull();
  });

  it("parses a timestamp beyond 2^31 (epoch-ms, not epoch-seconds)", () => {
    // 2^31 = 2147483648; a real epoch-ms value well past 2038's 32-bit wrap.
    const bigTs = 1759500000000;
    expect(parseSnapshotPath(`proj1/snapshots/0x2E5B73/${bigTs}/ch0.jpg`)).toEqual({
      projectId: "proj1",
      rfId: "0x2E5B73",
      ts: bigTs,
      channel: 0,
    });
  });

  it("rejects an empty string", () => {
    expect(parseSnapshotPath("")).toBeNull();
  });
});
