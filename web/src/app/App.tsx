// Root app: providers + router. Feature tracks each expose a default-exported
// page component at a fixed path (see imports below); this file wires routes.
import { lazy, Suspense } from "react";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { AuthProvider, useAuth } from "./AuthProvider";
import { ProjectProvider, useProject } from "./ProjectProvider";
import { DEV_SIMULATOR } from "@/lib/firebase";

// Feature pages (created by tracks). Each is a default export.
import SignInPage from "@/features/auth/SignInPage";
import OperationsPage from "@/features/operations/OperationsPage";
import { AppLayout } from "./AppLayout";
import { useT } from "@/i18n/I18nProvider";

// Operations is the landing route and stays in the main bundle. The rest are
// split out: most sessions never open Configure, Members or Settings, and the
// app previously shipped all of it as one 868KB chunk.
const CreateProjectPage = lazy(() => import("@/features/setup/CreateProjectPage"));
const SettingsPage = lazy(() => import("@/features/setup/SettingsPage"));
const MembersPage = lazy(() => import("@/features/setup/MembersPage"));
const ConfigurePage = lazy(() => import("@/features/configure/ConfigurePage"));
const ExplorePage = lazy(() => import("@/features/explore/ExplorePage"));
const SimulatorPage = lazy(() => import("@/features/simulator/SimulatorPage"));

function Gate() {
  const t = useT();
  const { user, userDoc, access, loading: authLoading, signOut } = useAuth();
  const { memberships, loading: projLoading } = useProject();

  if (authLoading) return <div className="app-main">{t("common.loading")}</div>;
  if (!user) return <SignInPage />;
  if (access === "checking")
    return <div className="app-main">{t("auth.checkingAccess")}</div>;

  // Uninvited account: authenticated with Google but not provisioned. Nothing
  // was written to the DB. Offer a way out.
  if (access === "denied") {
    return (
      <div className="app-main">
        <div className="card">
          <h1>{t("auth.accessDenied")}</h1>
          <p>{t("auth.accessDeniedBody", { email: user.email ?? "" })}</p>
          <button className="btn" onClick={() => void signOut()}>
            {t("common.signOut")}
          </button>
        </div>
      </div>
    );
  }

  if (projLoading) return <div className="app-main">{t("common.loading")}</div>;

  // Allowed but no projects yet. System admins can create one; others wait for
  // an invite to assign them to a project.
  if (memberships.length === 0) {
    if (userDoc?.isSystemAdmin) return <CreateProjectPage />;
    return (
      <div className="app-main">
        <div className="card">
          <h1>{t("auth.noProjects")}</h1>
          <p>{t("auth.noProjectsBody")}</p>
          <button className="btn" onClick={() => void signOut()}>
            {t("common.signOut")}
          </button>
        </div>
      </div>
    );
  }

  return (
    <AppLayout>
      <Suspense fallback={<p>{t("common.loading")}</p>}>
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
      </Suspense>
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
