import { describe, it, expect } from "vitest";
import {
  pendingAlarmId,
  isPendingAlarmStale,
  PENDING_FALLBACK_SEC,
  type PendingAlarm,
} from "./pendingAlarm";

describe("pendingAlarmId", () => {
  // Keyed by FAMILY, which is the only identity both writers can compute:
  // onAlarm has the cause (a 20-bit family when the device wrote it, a full
  // 24-bit rfId when the server did), and onSnapshotUploaded has the
  // snapshot's full rfId. The armed gate already joins these two the same way.
  it("derives the same id from a device-written family and a full rfId", () => {
    expect(pendingAlarmId("0x009BF")).toBe("0x009BF");
    expect(pendingAlarmId("0x009BFA")).toBe("0x009BF");
  });

  it("canonicalises case", () => {
    expect(pendingAlarmId("0x009bf")).toBe("0x009BF");
  });

  it("returns null for an unparseable cause", () => {
    expect(pendingAlarmId("")).toBe(null);
    expect(pendingAlarmId("not-hex")).toBe(null);
    expect(pendingAlarmId(undefined)).toBe(null);
  });
});

describe("isPendingAlarmStale", () => {
  const marker: PendingAlarm = {
    at: 1_000_000,
    rfId: "0x009BF",
    label: "Shed motion",
    definite: false,
  };

  it("is not stale before the fallback deadline", () => {
    expect(isPendingAlarmStale(marker, 1_000_000 + 10_000)).toBe(false);
  });

  it("is stale once the fallback deadline passes", () => {
    const after = 1_000_000 + PENDING_FALLBACK_SEC * 1000 + 1;
    expect(isPendingAlarmStale(marker, after)).toBe(true);
  });

  // A marker with no usable timestamp cannot be aged, and leaving it forever
  // would mean an alarm that is never announced. Treat it as stale so the
  // sweeper sends the fallback and clears it.
  it("treats a marker with no timestamp as stale", () => {
    expect(isPendingAlarmStale({ ...marker, at: undefined }, 1_000_000)).toBe(true);
  });
});
