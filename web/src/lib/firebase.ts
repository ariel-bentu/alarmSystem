// Firebase SDK init. Reads config from Vite env vars (VITE_FIREBASE_*).
// When VITE_USE_EMULATORS=true, connects to local emulators.
//
// Only `app` and `auth` are initialised eagerly: resolving whether someone is
// signed in is on the critical path for the very first paint, and nothing can
// be shown until it settles. Firestore, RTDB and Functions are behind async
// accessors instead, because they are ~160KB of the SDK (Firestore alone is
// the largest single dependency in the app) and the signed-out sign-in screen
// touches none of them. Loading them with the shell meant every cold visit
// paid for Firestore before it could draw a Google button.
//
// Each accessor memoises the in-flight promise, not just the result, so
// concurrent callers during startup share one dynamic import rather than
// racing to initialise the same service twice.
import { initializeApp } from "firebase/app";
import {
  initializeAuth,
  connectAuthEmulator,
  indexedDBLocalPersistence,
  browserLocalPersistence,
  browserSessionPersistence,
} from "firebase/auth";
import type { Firestore } from "firebase/firestore";
import type { Database } from "firebase/database";
import type { Functions } from "firebase/functions";

const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
  databaseURL: import.meta.env.VITE_FIREBASE_DATABASE_URL,
};

const USE_EMULATORS = import.meta.env.VITE_USE_EMULATORS === "true";

export const app = initializeApp(firebaseConfig);

// `initializeAuth`, deliberately not `getAuth` — for startup latency, not
// bundle size.
//
// Auth being eager (see the header) puts it alone on the critical path, so
// whatever it does before settling is what the first paint waits on. `getAuth`
// hands `browserPopupRedirectResolver` to initialisation eagerly, and that
// resolver's `_shouldInitProactively` is true on mobile browsers, Safari and
// iOS. On exactly those devices the SDK then *awaits* loading a cross-origin
// iframe against the auth domain BEFORE it starts restoring the session, and
// `onAuthStateChanged` cannot fire until the whole chain finishes. For an
// installed PWA on a phone that is a wasted round-trip in series on every cold
// start, ahead of the session reload and `provisionUser` behind it.
//
// Wasted because it buys nothing here: the resolver services redirect sign-in
// and a pending `getRedirectResult`, and this app uses neither. `signIn` calls
// `signInWithPopup`, which takes a resolver as its third argument — so it is
// passed there, at the one moment it is genuinely needed. See AuthProvider.
//
// The persistence array is `getAuth`'s own hierarchy and must stay: without it
// `initializeAuth` falls back to in-memory persistence, signing every user out
// on every reload. Pinned by firebase.test.ts.
export const auth = initializeAuth(app, {
  persistence: [
    indexedDBLocalPersistence,
    browserLocalPersistence,
    browserSessionPersistence,
  ],
});

// Auth is eager, so its emulator wiring is too — and stays a static import,
// since a top-level await here would make this module async and delay every
// importer of `auth` on the critical path. The other three services connect
// inside their own initialiser, when the service is first created.
if (USE_EMULATORS) {
  connectAuthEmulator(auth, "http://localhost:9099", { disableWarnings: true });
}

let dbPromise: Promise<Firestore> | null = null;
let rtdbPromise: Promise<Database> | null = null;
let fnsPromise: Promise<Functions> | null = null;

// Resolved instances, published once the async accessors above have run.
// The path helpers in lib/firestore.ts and lib/rtdb.ts are synchronous and
// used inside already-async call sites; rather than turn ~16 of those into
// awaits, they read these through the getters below. Anything that reaches a
// helper has necessarily gone through a component that awaited the service
// first (see ensureServices), so by then these are populated.
let dbInstance: Firestore | null = null;
let rtdbInstance: Database | null = null;

/**
 * The Firestore instance, for synchronous path helpers.
 * Throws if called before getDb() has resolved — that would be a load-order
 * bug, and failing loudly beats a confusing "undefined is not an object"
 * from deep inside the SDK.
 */
export function dbSync(): Firestore {
  if (!dbInstance) {
    throw new Error("Firestore used before initialisation — await getDb() first");
  }
  return dbInstance;
}

/** The RTDB instance, for synchronous path helpers. See dbSync(). */
export function rtdbSync(): Database {
  if (!rtdbInstance) {
    throw new Error("RTDB used before initialisation — await getRtdb() first");
  }
  return rtdbInstance;
}

/**
 * Warm the services a signed-in session needs, in parallel.
 * Called once from the auth gate: past that point every route can rely on
 * the synchronous helpers, which keeps the lazy-loading confined to one place
 * instead of spreading awaits through every feature.
 */
export async function ensureServices(): Promise<void> {
  await Promise.all([getDb(), getRtdb()]);
}

/** Firestore, initialised on first use. */
export function getDb(): Promise<Firestore> {
  dbPromise ??= (async () => {
    const {
      initializeFirestore,
      connectFirestoreEmulator,
      persistentLocalCache,
      persistentMultipleTabManager,
    } = await import("firebase/firestore");

    // IndexedDB-backed cache so sensors, profiles and rules still render with
    // no network. The multi-tab manager keeps two open tabs from fighting over
    // the lease — without it the second tab silently falls back to
    // memory-only. Live alarm state comes from RTDB and is deliberately NOT
    // cached: a stale armed/alarm reading is worse than none, which is why the
    // UI shows an offline banner and disables arming.
    const db = initializeFirestore(app, {
      localCache: persistentLocalCache({
        tabManager: persistentMultipleTabManager(),
      }),
    });

    if (USE_EMULATORS) connectFirestoreEmulator(db, "localhost", 8080);
    dbInstance = db;
    return db;
  })();
  return dbPromise;
}

/** Realtime Database, initialised on first use. */
export function getRtdb(): Promise<Database> {
  rtdbPromise ??= (async () => {
    const { getDatabase, connectDatabaseEmulator } = await import(
      "firebase/database"
    );
    const rtdb = getDatabase(app);
    if (USE_EMULATORS) connectDatabaseEmulator(rtdb, "localhost", 9000);
    rtdbInstance = rtdb;
    return rtdb;
  })();
  return rtdbPromise;
}

/** Callable functions (europe-west1, same region as the DB). */
export function getFns(): Promise<Functions> {
  fnsPromise ??= (async () => {
    const { getFunctions, connectFunctionsEmulator } = await import(
      "firebase/functions"
    );
    const fns = getFunctions(app, "europe-west1");
    if (USE_EMULATORS) connectFunctionsEmulator(fns, "localhost", 5001);
    return fns;
  })();
  return fnsPromise;
}
