// Guards the lazy-service split in lib/firebase.ts.
//
// The point of that split is that a cold, signed-out load pays for app+auth
// only — Firestore and RTDB are ~120KB (brotli) of SDK that the sign-in screen
// never touches. That property lives entirely in the module's import graph, so
// it cannot be caught by typechecking and would regress silently the moment
// someone re-adds a top-level `import { getFirestore } from "firebase/firestore"`.
import { describe, it, expect, vi, beforeEach } from "vitest";

const initializeApp = vi.fn(() => ({ name: "[DEFAULT]" }));
const getAuth = vi.fn(() => ({ id: "auth" }));
const connectAuthEmulator = vi.fn();

const initializeFirestore = vi.fn(() => ({ id: "firestore" }));
const getDatabase = vi.fn(() => ({ id: "rtdb" }));
const getFunctions = vi.fn(() => ({ id: "functions" }));

vi.mock("firebase/app", () => ({ initializeApp: () => initializeApp() }));
vi.mock("firebase/auth", () => ({
  getAuth: () => getAuth(),
  connectAuthEmulator: (...a: unknown[]) => connectAuthEmulator(...a),
}));
vi.mock("firebase/firestore", () => ({
  initializeFirestore: () => initializeFirestore(),
  connectFirestoreEmulator: vi.fn(),
  persistentLocalCache: vi.fn(() => ({ kind: "persistent" })),
  persistentMultipleTabManager: vi.fn(() => ({ kind: "multi-tab" })),
}));
vi.mock("firebase/database", () => ({
  getDatabase: () => getDatabase(),
  connectDatabaseEmulator: vi.fn(),
}));
vi.mock("firebase/functions", () => ({
  getFunctions: () => getFunctions(),
  connectFunctionsEmulator: vi.fn(),
}));

beforeEach(() => {
  vi.clearAllMocks();
  vi.resetModules();
});

describe("firebase service init", () => {
  it("initialises only app and auth on import", async () => {
    await import("./firebase");

    expect(initializeApp).toHaveBeenCalledOnce();
    expect(getAuth).toHaveBeenCalledOnce();

    // The whole point of the split: importing the module must not drag
    // Firestore or RTDB along with it.
    expect(initializeFirestore).not.toHaveBeenCalled();
    expect(getDatabase).not.toHaveBeenCalled();
    expect(getFunctions).not.toHaveBeenCalled();
  });

  it("initialises each heavy service only when first requested", async () => {
    const fb = await import("./firebase");

    await fb.getDb();
    expect(initializeFirestore).toHaveBeenCalledOnce();
    expect(getDatabase).not.toHaveBeenCalled();

    await fb.getRtdb();
    expect(getDatabase).toHaveBeenCalledOnce();

    await fb.getFns();
    expect(getFunctions).toHaveBeenCalledOnce();
  });

  it("memoises each service across concurrent and repeat calls", async () => {
    const fb = await import("./firebase");

    // Concurrent callers during startup must share one initialisation, not
    // race and build two Firestore instances (which the SDK rejects).
    const [a, b] = await Promise.all([fb.getDb(), fb.getDb()]);
    const c = await fb.getDb();

    expect(initializeFirestore).toHaveBeenCalledOnce();
    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  it("exposes the instances synchronously once resolved", async () => {
    const fb = await import("./firebase");

    // The sync accessors back the path helpers in lib/firestore + lib/rtdb,
    // which are called from already-async code after ensureServices().
    expect(() => fb.dbSync()).toThrow(/before initialisation/);
    expect(() => fb.rtdbSync()).toThrow(/before initialisation/);

    await fb.ensureServices();

    expect(fb.dbSync()).toEqual({ id: "firestore" });
    expect(fb.rtdbSync()).toEqual({ id: "rtdb" });
  });

  it("warms both Firestore and RTDB in ensureServices", async () => {
    const fb = await import("./firebase");
    await fb.ensureServices();

    expect(initializeFirestore).toHaveBeenCalledOnce();
    expect(getDatabase).toHaveBeenCalledOnce();
    // Functions is not needed to render an authed route, so it stays lazy.
    expect(getFunctions).not.toHaveBeenCalled();
  });
});
