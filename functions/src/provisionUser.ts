// Cloud Function: provisionUser (callable)
// Called by the web app right after Google sign-in. Owns all writes to /users
// (clients cannot write /users directly). Enforces the access model:
//   - /users empty        → caller becomes the first system admin (bootstrap)
//   - /users/{email} found → allowed; returns the profile
//   - otherwise            → denied, nothing written
import { onCall, HttpsError } from "firebase-functions/v2/https";
import { db } from "./admin";
import { decideProvision } from "./provisionLogic";
import type { UserDoc } from "./types";

export const provisionUser = onCall(
  { region: "europe-west1" },
  async (request) => {
    const auth = request.auth;
    if (!auth || !auth.token.email) {
      throw new HttpsError("unauthenticated", "Sign-in required.");
    }
    const email = auth.token.email.toLowerCase();
    const usersCol = db.collection("users");
    const userRef = usersCol.doc(email);

    // Is the collection empty? One-doc limit query is enough.
    const [firstDocSnap, userSnap] = await Promise.all([
      usersCol.limit(1).get(),
      userRef.get(),
    ]);

    const decision = decideProvision({
      usersCollectionEmpty: firstDocSnap.empty,
      userDocExists: userSnap.exists,
    });

    if (decision.action === "deny") {
      return { status: "denied" as const };
    }

    if (decision.action === "bootstrap") {
      const profile: Omit<UserDoc, "id"> = {
        email,
        displayName: (auth.token.name as string) ?? email,
        photoURL: (auth.token.picture as string) ?? "",
        isSystemAdmin: true,
        tenants: {},
      };
      // Guard the bootstrap against a race: only create if still absent.
      await db.runTransaction(async (tx) => {
        const fresh = await tx.get(usersCol.limit(1));
        if (!fresh.empty) return; // someone else won; fall through to allow
        tx.set(userRef, profile);
      });
      const after = await userRef.get();
      return {
        status: "ok" as const,
        user: { id: email, ...(after.data() as Omit<UserDoc, "id">) },
      };
    }

    // allow: refresh displayName/photoURL from the latest Google profile, and
    // ensure isSystemAdmin exists (a stub created by grantTenantAccess for a
    // pre-invited user has no such field yet).
    const existing = userSnap.data() as Partial<UserDoc>;
    await userRef.set(
      {
        email,
        displayName: (auth.token.name as string) ?? email,
        photoURL: (auth.token.picture as string) ?? "",
        isSystemAdmin: existing.isSystemAdmin ?? false,
        tenants: existing.tenants ?? {},
      },
      { merge: true }
    );
    const data = (await userRef.get()).data() as Omit<UserDoc, "id">;
    return { status: "ok" as const, user: { id: email, ...data } };
  }
);
