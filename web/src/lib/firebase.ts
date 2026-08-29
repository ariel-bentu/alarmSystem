// Firebase SDK init. Reads config from Vite env vars (VITE_FIREBASE_*).
// When VITE_USE_EMULATORS=true, connects to local emulators.
import { initializeApp } from "firebase/app";
import { getAuth, connectAuthEmulator } from "firebase/auth";
import {
  initializeFirestore,
  connectFirestoreEmulator,
  persistentLocalCache,
  persistentMultipleTabManager,
} from "firebase/firestore";
import { getDatabase, connectDatabaseEmulator } from "firebase/database";
import {
  getFunctions,
  connectFunctionsEmulator,
} from "firebase/functions";

const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
  databaseURL: import.meta.env.VITE_FIREBASE_DATABASE_URL,
};

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
// IndexedDB-backed cache so sensors, profiles and rules still render with no
// network. The multi-tab manager keeps two open tabs from fighting over the
// lease — without it the second tab silently falls back to memory-only.
// Live alarm state comes from RTDB and is deliberately NOT cached: a stale
// armed/alarm reading is worse than none, which is why the UI shows an
// offline banner and disables arming.
export const db = initializeFirestore(app, {
  localCache: persistentLocalCache({
    tabManager: persistentMultipleTabManager(),
  }),
});
export const rtdb = getDatabase(app);
// Callable functions live in europe-west1 (same region as the DB).
export const functions = getFunctions(app, "europe-west1");

if (import.meta.env.VITE_USE_EMULATORS === "true") {
  connectAuthEmulator(auth, "http://localhost:9099", { disableWarnings: true });
  connectFirestoreEmulator(db, "localhost", 8080);
  connectDatabaseEmulator(rtdb, "localhost", 9000);
  connectFunctionsEmulator(functions, "localhost", 5001);
}

// True only in a dev build with the simulator flag set.
export const DEV_SIMULATOR =
  import.meta.env.VITE_DEV_SIMULATOR === "true";
