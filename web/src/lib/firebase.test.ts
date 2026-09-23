// Guards the lazy-service split in lib/firebase.ts.
//
// The point of that split is that a cold, signed-out load pays for app+auth
// only — Firestore and RTDB are ~120KB (brotli) of SDK that the sign-in screen
// never touches. That property lives entirely in the module's import graph, so
// it cannot be caught by typechecking and would regress silently the moment
// someone re-adds a top-level `import { getFirestore } from "firebase/firestore"`.
import { describe, it, expect, vi, beforeEach } from "vitest";

const initializeApp = vi.fn(() => ({ name: "[DEFAULT]" }));
// Typed with the deps argument: the assertions below inspect what auth is
// initialised *with*, which is inferred away by a zero-arg mock.
const initializeAuth = vi.fn(
  (_app: unknown, _deps?: Record<string, unknown>) => ({ id: "auth" }),
);
const getAuth = vi.fn(() => ({ id: "auth" }));
const connectAuthEmulator = vi.fn();

const initializeFirestore = vi.fn(() => ({ id: "firestore" }));
const getDatabase = vi.fn(() => ({ id: "rtdb" }));
const getFunctions = vi.fn(() => ({ id: "functions" }));

vi.mock("firebase/app", () => ({ initializeApp: () => initializeApp() }));
vi.mock("firebase/auth", () => ({
  initializeAuth: (app: unknown, deps?: Record<string, unknown>) =>
    initializeAuth(app, deps),
  getAuth: () => getAuth(),
  connectAuthEmulator: (...a: unknown[]) => connectAuthEmulator(...a),
  indexedDBLocalPersistence: { id: "idb" },
  browserLocalPersistence: { id: "local" },
  browserSessionPersistence: { id: "session" },
  browserPopupRedirectResolver: { id: "resolver" },
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
    expect(initializeAuth).toHaveBeenCalledOnce();

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

// Startup latency, not bundle size — and invisible to every other test here.
//
// `getAuth` hands `browserPopupRedirectResolver` to auth initialisation
// eagerly, and that resolver's `_shouldInitProactively` is true on mobile
// browsers, Safari and iOS. On exactly those devices the SDK then *awaits*
// loading a cross-origin iframe against the auth domain BEFORE it begins
// restoring the session, and `onAuthStateChanged` cannot fire until the whole
// chain finishes — so `Gate()` sits on its spinner through a wasted round-trip
// on every cold start of the installed PWA.
//
// Nothing in this app uses redirect sign-in; `signIn` calls `signInWithPopup`,
// which takes the resolver as its third argument. So it is passed there.
//
// Reverting lib/firebase.ts to `getAuth(app)` would reintroduce the delay with
// every other test in the suite still green. Hence these two.
describe("auth initialisation", () => {
  it("does not hand the popup-redirect resolver to initializeAuth", async () => {
    await import("./firebase");

    // getAuth is what bakes the resolver in; using it is the regression.
    expect(getAuth).not.toHaveBeenCalled();

    const deps = initializeAuth.mock.calls[0][1] ?? {};
    expect(deps.popupRedirectResolver).toBeUndefined();
  });

  it("keeps the full persistence hierarchy getAuth would have used", async () => {
    // Omitting this silently downgrades auth to in-memory persistence, which
    // signs every user out on every reload — far worse than the delay above,
    // and it would not fail any other test.
    await import("./firebase");

    const deps = initializeAuth.mock.calls[0][1] ?? {};
    expect(deps.persistence).toEqual([
      { id: "idb" },
      { id: "local" },
      { id: "session" },
    ]);
  });
});
