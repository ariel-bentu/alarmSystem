// Members management (admin-only): list members, grant access by email + role.
// Access is granted immediately via the grantTenantAccess Cloud Function, which
// creates the member doc and the target user's users.tenants entry (a stub if
// they've never logged in). No pending-invite acceptance step.
import { useEffect, useState } from "react";
import { getDocs } from "firebase/firestore";
import { httpsCallable } from "firebase/functions";
import { useAuth } from "@/app/AuthProvider";
import { useProject } from "@/app/ProjectProvider";
import { functions } from "@/lib/firebase";
import { membersCol } from "@/lib/firestore";
import type { Member, Role } from "@/types";

const grantTenantAccess = httpsCallable<
  { projectId: string; email: string; role: Role },
  { status: string }
>(functions, "grantTenantAccess");

export default function MembersPage() {
  const { user } = useAuth();
  const { project, role } = useProject();

  const [members, setMembers] = useState<Member[]>([]);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<Role>("user");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const loadData = async () => {
    if (!project) return;
    const snap = await getDocs(membersCol(project.id));
    setMembers(snap.docs.map((d) => d.data()));
  };

  useEffect(() => {
    void loadData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project?.id]);

  if (!project || !user) return <div>Loading...</div>;
  if (role !== "admin") return <div>Admin access required.</div>;

  const handleGrant = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    setNotice(null);
    try {
      const email = inviteEmail.trim().toLowerCase();
      await grantTenantAccess({ projectId: project.id, email, role: inviteRole });
      setInviteEmail("");
      setNotice(`${email} now has ${inviteRole} access.`);
      await loadData();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to grant access.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="members-page">
      <h1>Members</h1>

      <section>
        <h2>Current Members</h2>
        <ul>
          {members.map((m) => (
            <li key={m.id}>
              {m.email} — <strong>{m.role}</strong>
            </li>
          ))}
        </ul>
      </section>

      <section>
        <h2>Add a Member</h2>
        <form onSubmit={handleGrant}>
          <input
            type="email"
            placeholder="Email address"
            value={inviteEmail}
            onChange={(e) => setInviteEmail(e.target.value)}
            required
          />
          <select
            value={inviteRole}
            onChange={(e) => setInviteRole(e.target.value as Role)}
          >
            <option value="user">User</option>
            <option value="admin">Admin</option>
          </select>
          <button type="submit" disabled={submitting}>
            {submitting ? "Adding..." : "Add Member"}
          </button>
        </form>
        {notice && <p className="notice">{notice}</p>}
        {error && <p className="error">{error}</p>}
      </section>
    </div>
  );
}
