// Cloud Function: grantTenantAccess (callable)
// Adds a user (by email) to a project with a role. Owns the paired writes that
// clients cannot make directly:
//   - projects/{projectId}/members/{email}
//   - users/{email}.tenants[projectId] = { name, role }
// If the target user has never logged in, a stub /users doc is created so the
// tenant entry has a home; provisionUser fills in profile fields on their first
// login (and, crucially, lets them past the access gate).
//
// Authorization: caller must be a system admin, OR an admin member of the
// target project.
import { onCall, HttpsError } from "firebase-functions/v2/https";
import { FieldValue } from "firebase-admin/firestore";
import { db } from "./admin";
import type { Role, UserDoc, Member } from "./types";

interface GrantInput {
  projectId: string;
  email: string;
  role: Role;
}

export const grantTenantAccess = onCall(
  { region: "europe-west1" },
  async (request) => {
    const auth = request.auth;
    if (!auth || !auth.token.email) {
      throw new HttpsError("unauthenticated", "Sign-in required.");
    }
    const callerEmail = auth.token.email.toLowerCase();
    const { projectId, email, role } = (request.data ?? {}) as GrantInput;

    if (!projectId || !email || (role !== "admin" && role !== "user")) {
      throw new HttpsError("invalid-argument", "projectId, email, role required.");
    }
    const targetEmail = email.toLowerCase();

    // Authorization: system admin or project admin.
    const [callerUserSnap, callerMemberSnap, projectSnap] = await Promise.all([
      db.doc(`users/${callerEmail}`).get(),
      db.doc(`projects/${projectId}/members/${callerEmail}`).get(),
      db.doc(`projects/${projectId}`).get(),
    ]);
    const isSystemAdmin =
      callerUserSnap.exists &&
      (callerUserSnap.data() as UserDoc).isSystemAdmin === true;
    const isProjectAdmin =
      callerMemberSnap.exists &&
      (callerMemberSnap.data() as Member).role === "admin";
    if (!isSystemAdmin && !isProjectAdmin) {
      throw new HttpsError("permission-denied", "Admin access required.");
    }
    if (!projectSnap.exists) {
      throw new HttpsError("not-found", "Project not found.");
    }
    const projectName = (projectSnap.data() as { name: string }).name;

    const memberRef = db.doc(`projects/${projectId}/members/${targetEmail}`);
    const userRef = db.doc(`users/${targetEmail}`);

    await db.runTransaction(async (tx) => {
      const member: Omit<Member, "id"> = {
        role,
        email: targetEmail,
        invitedBy: callerEmail,
        joinedAt: FieldValue.serverTimestamp() as unknown as Member["joinedAt"],
      };
      tx.set(memberRef, member, { merge: true });

      // Create/merge the target user's profile with the tenant entry. A stub is
      // fine — provisionUser completes it on first login.
      const stub: Partial<UserDoc> = {
        email: targetEmail,
        tenants: { [projectId]: { name: projectName, role } },
      };
      tx.set(userRef, stub, { merge: true });
    });

    return { status: "ok" as const };
  }
);
