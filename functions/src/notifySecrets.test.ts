import { describe, it, expect, vi } from "vitest";
import { loadNotifySecrets, notifySecretsPath } from "./notifySecrets";

// Minimal Firestore stand-in: only doc().get() is exercised.
// Mirrors judgeConfig.test.ts's fakeDb.
function fakeDb(doc: { exists: boolean; data?: Record<string, unknown> } | Error) {
  const get = vi.fn(async () => {
    if (doc instanceof Error) throw doc;
    return { exists: doc.exists, data: () => doc.data };
  });
  const docFn = vi.fn(() => ({ get }));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { db: { doc: docFn } as any, docFn, get };
}

describe("notifySecretsPath", () => {
  it("points at a subcollection of the project doc", () => {
    expect(notifySecretsPath("proj1")).toBe("projects/proj1/secrets/notify");
  });
});

describe("loadNotifySecrets", () => {
  it("reads the per-project secrets path", async () => {
    const { db, docFn } = fakeDb({ exists: true, data: {} });
    await loadNotifySecrets(db, "proj1");
    expect(docFn).toHaveBeenCalledWith("projects/proj1/secrets/notify");
  });

  it("returns both credentials when both are set", async () => {
    const { db } = fakeDb({
      exists: true,
      data: { pushoverToken: "atoken", pushoverUserKey: "ukey" },
    });
    expect(await loadNotifySecrets(db, "p")).toEqual({
      pushoverToken: "atoken",
      pushoverUserKey: "ukey",
    });
  });

  it("returns the device list normalised, and omits a blank one", async () => {
    const { db } = fakeDb({
      exists: true,
      data: { pushoverToken: "a", pushoverUserKey: "u", pushoverDevices: " iphone, ipad ," },
    });
    expect((await loadNotifySecrets(db, "p")).pushoverDevices).toBe("iphone,ipad");
    const blank = fakeDb({ exists: true, data: { pushoverDevices: " , " } });
    expect(await loadNotifySecrets(blank.db, "p")).toEqual({});
  });

  it("returns only the field that is present", async () => {
    const { db } = fakeDb({ exists: true, data: { pushoverToken: "atoken" } });
    expect(await loadNotifySecrets(db, "p")).toEqual({ pushoverToken: "atoken" });
  });

  it("returns an empty set when the doc does not exist", async () => {
    const { db } = fakeDb({ exists: false });
    expect(await loadNotifySecrets(db, "p")).toEqual({});
  });

  it("ignores blank and non-string values", async () => {
    const { db } = fakeDb({
      exists: true,
      data: { pushoverToken: "   ", pushoverUserKey: 42 },
    });
    expect(await loadNotifySecrets(db, "p")).toEqual({});
  });

  // A thrown read must never take down the notification path: the other
  // channel still has to fire.
  it("swallows a Firestore read failure and returns an empty set", async () => {
    const { db } = fakeDb(new Error("permission denied"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await loadNotifySecrets(db, "p")).toEqual({});
  });
});
