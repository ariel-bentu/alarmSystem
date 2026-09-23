// Auth context: current Firebase user + sign-in/out, plus the access gate.
// After Google sign-in we call the provisionUser Cloud Function, which owns
// all /users writes and decides whether this account is allowed in:
//   - first user ever  → bootstrapped as system admin
//   - known user       → allowed
//   - uninvited        → denied (nothing written)
import {
  createContext,
  useContext,
  useEffect,
  useState,
  ReactNode,
} from "react";
import {
  GoogleAuthProvider,
  signInWithPopup,
  browserPopupRedirectResolver,
  signOut as fbSignOut,
  onAuthStateChanged,
  User,
} from "firebase/auth";
import { auth, getFns, ensureServices } from "@/lib/firebase";
import type { UserDoc } from "@/types";

type AccessStatus = "checking" | "ok" | "denied";

interface ProvisionResult {
  status: "ok" | "denied";
  user?: UserDoc;
}

interface AuthContextValue {
  user: User | null; // Firebase Auth user
  userDoc: UserDoc | null; // provisioned /users profile
  access: AccessStatus;
  loading: boolean;
  signIn: () => Promise<void>;
  signOut: () => Promise<void>;
  reloadUserDoc: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

// Resolved lazily rather than at module scope: this module is on the
// first-paint path (it owns the auth handshake), and binding the callable
// eagerly would pull firebase/functions into the initial bundle for a call
// that only happens after someone is actually signed in.
async function provisionUser() {
  const fns = await getFns();
  const { httpsCallable } = await import("firebase/functions");
  return httpsCallable<void, ProvisionResult>(fns, "provisionUser")();
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [userDoc, setUserDoc] = useState<UserDoc | null>(null);
  const [access, setAccess] = useState<AccessStatus>("checking");
  const [loading, setLoading] = useState(true);

  const runProvision = async () => {
    setAccess("checking");
    try {
      const res = await provisionUser();
      if (res.data.status === "ok" && res.data.user) {
        setUserDoc(res.data.user);
        setAccess("ok");
      } else {
        setUserDoc(null);
        setAccess("denied");
      }
    } catch {
      setUserDoc(null);
      setAccess("denied");
    }
  };

  useEffect(() => {
    return onAuthStateChanged(auth, async (u) => {
      setUser(u);
      if (u) {
        // Start Firestore and RTDB NOW, alongside the provision call rather
        // than after it. ProjectProvider awaits ensureServices() before its
        // first read, and that used to be the earliest either SDK was touched
        // — so evaluating both chunks and opening the Firestore channel and
        // the RTDB websocket all queued up behind provisionUser's round trip
        // (measured at ~530ms, of which ~440ms is server time). Warming here
        // overlaps that latency with work every signed-in session needs
        // regardless of the outcome.
        //
        // Deliberately not awaited: provisioning must not wait on the SDKs,
        // and ensureServices() memoises its promise, so ProjectProvider's
        // later await joins this same in-flight work instead of redoing it.
        //
        // The catch is required, not defensive noise: an unawaited rejection
        // here would be an unhandled promise rejection. Swallowing it is
        // correct because this is only a warm-up — if a service genuinely
        // cannot initialise, ProjectProvider's own await surfaces the failure
        // at the point where it actually blocks something.
        void ensureServices().catch(() => {});
        await runProvision();
      } else {
        setUserDoc(null);
        setAccess("checking");
      }
      setLoading(false);
    });
  }, []);

  const signIn = async () => {
    // The resolver is passed here rather than baked into initializeAuth, so
    // its iframe loads when someone actually signs in instead of on every
    // cold start. See the comment on `auth` in lib/firebase.ts.
    await signInWithPopup(
      auth,
      new GoogleAuthProvider(),
      browserPopupRedirectResolver,
    );
  };
  const signOut = async () => {
    await fbSignOut(auth);
    setUserDoc(null);
    setAccess("checking");
  };

  return (
    <AuthContext.Provider
      value={{
        user,
        userDoc,
        access,
        loading,
        signIn,
        signOut,
        reloadUserDoc: runProvision,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
