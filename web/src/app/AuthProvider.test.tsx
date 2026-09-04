// Guards the startup overlap in AuthProvider.
//
// ensureServices() is fired alongside provisionUser(), not after it. That
// ordering is the whole point: ProjectProvider awaits ensureServices() before
// its first read, so when the warm-up only started there, evaluating the
// Firestore and RTDB chunks plus opening both connections queued behind
// provisionUser's round trip (~530ms measured). This asserts the two are
// genuinely concurrent, which is invisible to typechecking and would regress
// silently if someone moved the call below the await.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, waitFor, act } from "@testing-library/react";

let authCallback: ((u: unknown) => void) | null = null;

const ensureServices = vi.fn(() => Promise.resolve());
const getFns = vi.fn(() => Promise.resolve({ id: "functions" }));
const callable = vi.fn(() =>
  Promise.resolve({ data: { status: "ok", user: { id: "a@b.c", tenants: {} } } })
);

vi.mock("@/lib/firebase", () => ({
  auth: { id: "auth" },
  getFns: () => getFns(),
  ensureServices: () => ensureServices(),
}));

vi.mock("firebase/auth", () => ({
  onAuthStateChanged: (_a: unknown, cb: (u: unknown) => void) => {
    authCallback = cb;
    return () => {};
  },
  GoogleAuthProvider: class {},
  signInWithPopup: vi.fn(),
  signOut: vi.fn(),
}));

vi.mock("firebase/functions", () => ({
  httpsCallable: () => callable,
}));

beforeEach(() => {
  vi.clearAllMocks();
  authCallback = null;
});

describe("AuthProvider startup", () => {
  it("warms Firestore and RTDB without waiting for provisionUser", async () => {
    // provisionUser hangs: nothing downstream of its await can have run.
    let releaseProvision: () => void = () => {};
    callable.mockReturnValueOnce(
      new Promise((res) => {
        releaseProvision = () =>
          res({ data: { status: "ok", user: { id: "a@b.c", tenants: {} } } });
      }) as ReturnType<typeof callable>
    );

    const { AuthProvider } = await import("./AuthProvider");
    render(<AuthProvider>{null}</AuthProvider>);

    await act(async () => {
      authCallback?.({ uid: "u1", email: "a@b.c" });
    });

    // The warm-up must have been kicked off even though provisionUser has not
    // settled. If it were awaited after it, this would never be called.
    await waitFor(() => expect(ensureServices).toHaveBeenCalledOnce());
    expect(callable).toHaveBeenCalledOnce();

    // Let the held provision settle inside act(), so the state updates it
    // triggers are flushed before the test tears the tree down.
    await act(async () => {
      releaseProvision();
    });
  });

  it("does not warm services for a signed-out visitor", async () => {
    const { AuthProvider } = await import("./AuthProvider");
    render(<AuthProvider>{null}</AuthProvider>);

    // The sign-in screen touches neither Firestore nor RTDB, and paying for
    // ~120KB of SDK to render a Google button is what the lazy split exists
    // to avoid.
    await act(async () => {
      authCallback?.(null);
    });

    await waitFor(() => expect(ensureServices).not.toHaveBeenCalled());
  });

  it("still resolves access when the warm-up fails", async () => {
    // The warm-up is unawaited, so a rejection must not become an unhandled
    // rejection or block provisioning — a user whose SDK init failed should
    // still get through the gate and hit the failure where it actually
    // matters, in ProjectProvider's own await.
    ensureServices.mockRejectedValueOnce(new Error("offline"));

    const { AuthProvider } = await import("./AuthProvider");
    render(<AuthProvider>{null}</AuthProvider>);

    await act(async () => {
      authCallback?.({ uid: "u1", email: "a@b.c" });
    });

    await waitFor(() => expect(callable).toHaveBeenCalledOnce());
  });
});
