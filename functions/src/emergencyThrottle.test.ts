import { describe, it, expect, vi } from "vitest";
import {
  EMERGENCY_WINDOW_MS,
  claimEmergency,
  clearEmergency,
  emergencyAllowed,
} from "./emergencyThrottle";

describe("emergencyAllowed", () => {
  const now = 1_000_000_000;

  it("allows when no emergency has been sent", () => {
    expect(emergencyAllowed(undefined, now)).toBe(true);
    expect(emergencyAllowed({}, now)).toBe(true);
  });

  it("blocks inside the window", () => {
    expect(emergencyAllowed({ at: now - 1000 }, now)).toBe(false);
    expect(emergencyAllowed({ at: now - EMERGENCY_WINDOW_MS + 1 }, now)).toBe(false);
  });

  it("allows once the window has passed", () => {
    expect(emergencyAllowed({ at: now - EMERGENCY_WINDOW_MS }, now)).toBe(true);
  });

  // Clock skew must not become an indefinite suppression.
  it("allows when the marker is in the future", () => {
    expect(emergencyAllowed({ at: now + 60_000 }, now)).toBe(true);
  });
});

/** A one-document in-memory Firestore, enough for the transaction shape used. */
function fakeDb(initial?: { at: number }) {
  let data: { at: number } | undefined = initial;
  const ref = {
    delete: vi.fn(async () => {
      data = undefined;
    }),
  };
  const db = {
    doc: vi.fn(() => ref),
    runTransaction: vi.fn(async (fn: (tx: unknown) => Promise<boolean>) =>
      fn({
        get: async () => ({ exists: data !== undefined, data: () => data }),
        set: (_r: unknown, v: { at: number }) => {
          data = v;
        },
      })
    ),
  };
  return { db: db as never, read: () => data, ref };
}

describe("claimEmergency", () => {
  const now = 2_000_000_000;

  it("claims an empty window and records it", async () => {
    const f = fakeDb();
    expect(await claimEmergency(f.db, "p", now)).toBe(true);
    expect(f.read()).toEqual({ at: now });
  });

  it("refuses a second claim inside the window without moving it", async () => {
    const f = fakeDb({ at: now - 60_000 });
    expect(await claimEmergency(f.db, "p", now)).toBe(false);
    expect(f.read()).toEqual({ at: now - 60_000 });
  });

  it("fails loud when the transaction throws", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const db = {
      doc: vi.fn(() => ({})),
      runTransaction: vi.fn(async () => {
        throw new Error("unavailable");
      }),
    };
    expect(await claimEmergency(db as never, "p", now)).toBe(true);
  });

  // Disarm ends the window: the next arm cycle gets a fresh emergency.
  it("is claimable again after clearEmergency", async () => {
    const f = fakeDb({ at: now - 1000 });
    await clearEmergency(f.db, "p");
    expect(await claimEmergency(f.db, "p", now)).toBe(true);
  });
});
