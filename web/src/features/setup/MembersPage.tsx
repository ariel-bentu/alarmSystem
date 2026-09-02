// Members management (admin-only): list members, grant access by email + role.
// Access is granted immediately via the grantTenantAccess Cloud Function, which
// creates the member doc and the target user's users.tenants entry (a stub if
// they've never logged in). No pending-invite acceptance step.
import { useEffect, useState } from "react";
import { getDocs } from "firebase/firestore";
import { useAuth } from "@/app/AuthProvider";
import { useProject } from "@/app/ProjectProvider";
import { getFns } from "@/lib/firebase";
import { membersCol } from "@/lib/firestore";
import { useT } from "@/i18n/I18nProvider";
import type { Member, Role } from "@/types";

// Bound on call rather than at module scope, so firebase/functions loads only
// when an admin actually grants access.
async function grantTenantAccess(args: {
  projectId: string;
  email: string;
  role: Role;
}) {
  const fns = await getFns();
  const { httpsCallable } = await import("firebase/functions");
  return httpsCallable<typeof args, { status: string }>(
    fns,
    "grantTenantAccess"
  )(args);
}

export default function MembersPage() {
  const t = useT();
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

  if (!project || !user) return <div>{t("common.loading")}</div>;
  if (role !== "admin") return <div>{t("members.adminRequired")}</div>;

  const handleGrant = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    setNotice(null);
    try {
      const email = inviteEmail.trim().toLowerCase();
      await grantTenantAccess({ projectId: project.id, email, role: inviteRole });
      setInviteEmail("");
      setNotice(
        t("members.granted", { email, role: t(`members.role.${inviteRole}`) })
      );
      await loadData();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("members.grantFailed"));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div>
      <h1 className="sr-only">{t("members.title")}</h1>

      <section className="card">
        <div className="card__header">
          <h2 className="card__title">{t("members.currentMembers")}</h2>
        </div>
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>{t("members.email")}</th>
                <th>{t("members.role")}</th>
              </tr>
            </thead>
            <tbody>
              {members.map((m) => (
                <tr key={m.id}>
                  <td>
                    <span className="ltr">{m.email}</span>
                  </td>
                  <td>
                    <span className="badge">{t(`members.role.${m.role}`)}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="card">
        <div className="card__header">
          <h2 className="card__title">{t("members.addMember")}</h2>
        </div>
        <form onSubmit={handleGrant} className="stack">
          <div className="field">
            <label className="field__label" htmlFor="invite-email">
              {t("members.email")}
            </label>
            <input
              id="invite-email"
              className="input ltr"
              type="email"
              placeholder={t("members.emailPlaceholder")}
              value={inviteEmail}
              onChange={(e) => setInviteEmail(e.target.value)}
              required
            />
          </div>
          <div className="field">
            <label className="field__label" htmlFor="invite-role">
              {t("members.role")}
            </label>
            <select
              id="invite-role"
              className="input"
              value={inviteRole}
              onChange={(e) => setInviteRole(e.target.value as Role)}
            >
              <option value="user">{t("members.role.user")}</option>
              <option value="admin">{t("members.role.admin")}</option>
            </select>
          </div>
          <div>
            <button
              type="submit"
              className="btn btn--primary"
              disabled={submitting}
            >
              {submitting ? t("members.adding") : t("members.addButton")}
            </button>
          </div>
        </form>
        {notice && (
          <p className="badge badge--ok" role="status">
            {notice}
          </p>
        )}
        {error && (
          <p className="badge badge--danger" role="alert">
            {error}
          </p>
        )}
      </section>
    </div>
  );
}
