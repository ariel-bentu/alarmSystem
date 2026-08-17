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

  // Keep a valid selection as tenants change.
  useEffect(() => {
    setLoading(true);
    setSelectedId((prev) => {
      if (prev && memberships.some((m) => m.projectId === prev)) return prev;
      return memberships[0]?.projectId ?? null;
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

  return (
    <ProjectContext.Provider
      value={{
        memberships,
        project,
        role,
        loading,
        selectProject: setSelectedId,
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
