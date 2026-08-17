// Root app: providers + router. Feature tracks each expose a default-exported
// page component at a fixed path (see imports below); this file wires routes.
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { AuthProvider, useAuth } from "./AuthProvider";
import { ProjectProvider, useProject } from "./ProjectProvider";
import { DEV_SIMULATOR } from "@/lib/firebase";

// Feature pages (created by tracks). Each is a default export.
import SignInPage from "@/features/auth/SignInPage";
import CreateProjectPage from "@/features/setup/CreateProjectPage";
import SettingsPage from "@/features/setup/SettingsPage";
import MembersPage from "@/features/setup/MembersPage";
import ConfigurePage from "@/features/configure/ConfigurePage";
import OperationsPage from "@/features/operations/OperationsPage";
import ExplorePage from "@/features/explore/ExplorePage";
import SimulatorPage from "@/features/simulator/SimulatorPage";
import { AppLayout } from "./AppLayout";

function Gate() {
  const { user, userDoc, access, loading: authLoading, signOut } = useAuth();
  const { memberships, loading: projLoading } = useProject();

  if (authLoading) return <div>Loading…</div>;
  if (!user) return <SignInPage />;
  if (access === "checking") return <div>Checking access…</div>;

  // Uninvited account: authenticated with Google but not provisioned. Nothing
  // was written to the DB. Offer a way out.
  if (access === "denied") {
    return (
      <div style={{ padding: 24 }}>
        <h1>Access denied</h1>
        <p>
          This account isn’t authorised for the alarm system. Ask an
          administrator to invite <strong>{user.email}</strong>.
        </p>
        <button onClick={() => void signOut()}>Sign out</button>
      </div>
    );
  }

  if (projLoading) return <div>Loading…</div>;

  // Allowed but no projects yet. System admins can create one; others wait for
  // an invite to assign them to a project.
  if (memberships.length === 0) {
    if (userDoc?.isSystemAdmin) return <CreateProjectPage />;
    return (
      <div style={{ padding: 24 }}>
        <h1>No projects yet</h1>
        <p>
          You’re signed in as <strong>{user.email}</strong> but not assigned to
          any project. Ask an administrator to add you.
        </p>
        <button onClick={() => void signOut()}>Sign out</button>
      </div>
    );
  }

  return (
    <AppLayout>
      <Routes>
        <Route path="/" element={<OperationsPage />} />
        <Route path="/configure" element={<ConfigurePage />} />
        <Route path="/explore" element={<ExplorePage />} />
        <Route path="/members" element={<MembersPage />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="/setup" element={<CreateProjectPage />} />
        {DEV_SIMULATOR && (
          <Route path="/simulator" element={<SimulatorPage />} />
        )}
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </AppLayout>
  );
}

export function App() {
  return (
    <BrowserRouter
      future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
    >
      <AuthProvider>
        <ProjectProvider>
          <Routes>
            <Route path="*" element={<Gate />} />
          </Routes>
        </ProjectProvider>
      </AuthProvider>
    </BrowserRouter>
  );
}
