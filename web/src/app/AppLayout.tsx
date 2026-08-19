// Shell layout: project switcher, nav, sign-out. Wraps all authed pages.
import { ReactNode } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "./AuthProvider";
import { useProject } from "./ProjectProvider";
import { DEV_SIMULATOR } from "@/lib/firebase";

export function AppLayout({ children }: { children: ReactNode }) {
  const { user, signOut } = useAuth();
  const { project, role, memberships, selectProject } = useProject();

  return (
    <div>
      <header
        style={{
          display: "flex",
          gap: 16,
          alignItems: "center",
          padding: 12,
          borderBottom: "1px solid #ccc",
        }}
      >
        <strong>{project?.name ?? "Alarm"}</strong>
        {memberships.length > 1 && (
          <select
            value={project?.id ?? ""}
            onChange={(e) => selectProject(e.target.value)}
          >
            {memberships.map((m) => (
              <option key={m.projectId} value={m.projectId}>
                {m.name}
              </option>
            ))}
          </select>
        )}
        {/* Every RTDB read is namespaced by this id (/{projectId}/events,
            /config, /commands), and the device only writes to ONE of them.
            Showing it makes "am I looking at the project my device talks
            to?" answerable at a glance instead of by guessing — with it
            hidden, a wrong selection looks identical to a broken sensor. */}
        {project?.id && (
          <code
            title="Active projectId — RTDB paths are namespaced under this"
            style={{ fontSize: 11, opacity: 0.6, userSelect: "all" }}
          >
            {project.id}
          </code>
        )}
        <nav style={{ display: "flex", gap: 12 }}>
          <Link to="/">Operations</Link>
          {role === "admin" && <Link to="/configure">Configure</Link>}
          <Link to="/explore">Explore</Link>
          {role === "admin" && <Link to="/members">Members</Link>}
          {role === "admin" && <Link to="/settings">Settings</Link>}
          {DEV_SIMULATOR && <Link to="/simulator">Simulator</Link>}
        </nav>
        <span style={{ marginLeft: "auto" }}>{user?.email}</span>
        <button onClick={() => void signOut()}>Sign out</button>
      </header>
      <main style={{ padding: 16 }}>{children}</main>
    </div>
  );
}
