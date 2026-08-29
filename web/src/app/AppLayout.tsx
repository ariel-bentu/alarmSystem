// Shell layout: project switcher, nav, sign-out. Wraps all authed pages.
import { ReactNode } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "./AuthProvider";
import { useProject } from "./ProjectProvider";
import { DEV_SIMULATOR } from "@/lib/firebase";
import { useDeviceState } from "@/features/operations/useDeviceState";

export function AppLayout({ children }: { children: ReactNode }) {
  const { user, signOut } = useAuth();
  const { project, role, memberships, selectProject } = useProject();
  const { deviceOnline } = useDeviceState(project?.id);

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
        <span
          title={deviceOnline ? "Device online" : "Device offline or no heartbeat yet"}
          style={{
            display: "inline-block",
            width: 10,
            height: 10,
            borderRadius: "50%",
            background: deviceOnline ? "#22c55e" : "#d1d5db",
            flexShrink: 0,
          }}
        />
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

