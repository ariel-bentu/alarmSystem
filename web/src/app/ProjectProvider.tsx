// Project context: derives the user's projects from the provisioned UserDoc
// (its `tenants` map), tracks the selected project, and exposes the role.
// No Firestore membership query here — AuthProvider already loaded /users.
import {
  createContext,
  useContext,
  useEffect,
  useState,
  ReactNode,
} from "react";
import { getDoc } from "firebase/firestore";
import { projectDoc } from "@/lib/firestore";
import type { Project, Role } from "@/types";
import { useAuth } from "./AuthProvider";

interface Membership {
  projectId: string;
  name: string;
  role: Role;
}

interface ProjectContextValue {
  memberships: Membership[];
  project: Project | null; // currently selected project
  role: Role | null; // role in the selected project
  loading: boolean;
  selectProject: (projectId: string) => void;
  refresh: () => Promise<void>; // re-provision user doc (tenants)
  reloadProject: () => Promise<void>; // re-read the current project doc
}

const ProjectContext = createContext<ProjectContextValue | undefined>(
  undefined
);

// The selection used to default to memberships[0] on every load, and the
// order of that array comes from Object.entries() over the tenants map —
// i.e. effectively arbitrary. With more than one project that means the app
// can silently point every RTDB read (/{projectId}/events, /config,
// /commands) at a different project than the one your device writes to,
// which looks exactly like "my sensor triggers but nothing shows up".
// Persisting the choice makes it stable across reloads.
const SELECTED_PROJECT_KEY = "alarm.selectedProjectId";

function readStoredProjectId(): string | null {
  try {
    return localStorage.getItem(SELECTED_PROJECT_KEY);
  } catch {
    return null; // private mode / storage disabled
  }
}

function storeProjectId(projectId: string | null): void {
  try {
    if (projectId) localStorage.setItem(SELECTED_PROJECT_KEY, projectId);
    else localStorage.removeItem(SELECTED_PROJECT_KEY);
  } catch {
    // Non-fatal: selection just won't survive a reload.
  }
}

export function ProjectProvider({ children }: { children: ReactNode }) {
  const { userDoc, reloadUserDoc } = useAuth();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [project, setProject] = useState<Project | null>(null);
  const [loading, setLoading] = useState(true);

  // Memberships come straight from the tenants map on the provisioned user doc.
  const memberships: Membership[] = userDoc
    ? Object.entries(userDoc.tenants ?? {}).map(([projectId, t]) => ({
        projectId,
        name: t.name,
        role: t.role,
      }))
    : [];

  // Keep a valid selection as tenants change. Preference order: whatever is
  // already selected, then the persisted choice, then the first membership.
  // Any candidate that is no longer a membership is discarded.
  useEffect(() => {
    setLoading(true);
    setSelectedId((prev) => {
      const isMember = (id: string | null): id is string =>
        !!id && memberships.some((m) => m.projectId === id);

      if (isMember(prev)) return prev;

      const stored = readStoredProjectId();
      if (isMember(stored)) return stored;

      const fallback = memberships[0]?.projectId ?? null;
      storeProjectId(fallback);
      return fallback;
    });
    setLoading(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userDoc]);

  useEffect(() => {
    if (!selectedId) {
      setProject(null);
      return;
    }
    void getDoc(projectDoc(selectedId)).then((s) =>
      setProject(s.exists() ? s.data() : null)
    );
  }, [selectedId]);

  const role =
    memberships.find((m) => m.projectId === selectedId)?.role ?? null;

  // Re-provision to pull fresh tenants (e.g. after creating a project).
  const refresh = async () => {
    await reloadUserDoc();
  };

  // Re-read the current project doc (e.g. after editing settings).
  const reloadProject = async () => {
    if (!selectedId) return;
    const s = await getDoc(projectDoc(selectedId));
    setProject(s.exists() ? s.data() : null);
  };

  // Persist on explicit selection so the choice survives a reload.
  const selectProject = (projectId: string) => {
    storeProjectId(projectId);
    setSelectedId(projectId);
  };

  return (
    <ProjectContext.Provider
      value={{
        memberships,
        project,
        role,
        loading,
        selectProject,
        refresh,
        reloadProject,
      }}
    >
      {children}
    </ProjectContext.Provider>
  );
}

export function useProject(): ProjectContextValue {
  const ctx = useContext(ProjectContext);
  if (!ctx) throw new Error("useProject must be used within ProjectProvider");
  return ctx;
}
