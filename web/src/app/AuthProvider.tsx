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
  signOut as fbSignOut,
  onAuthStateChanged,
  User,
} from "firebase/auth";
import { auth, getFns } from "@/lib/firebase";
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
        await runProvision();
      } else {
        setUserDoc(null);
        setAccess("checking");
      }
      setLoading(false);
    });
  }, []);

  const signIn = async () => {
    await signInWithPopup(auth, new GoogleAuthProvider());
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
