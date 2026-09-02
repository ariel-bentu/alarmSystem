// Shell layout: identity row + scrolling nav row. Wraps all authed pages.
//
// The header used to be a single non-wrapping flex row holding the project
// name, online dot, project switcher, raw project id, six nav links, the
// user's email and sign-out. On a phone the later items were clipped and
// unreachable. It is now two rows: identity (which stays put) and navigation
// (which scrolls, with edge fades so it is obvious more exists).
import { ReactNode, useEffect, useRef, useState } from "react";
import { NavLink, useLocation } from "react-router-dom";
import { useAuth } from "./AuthProvider";
import { useProject } from "./ProjectProvider";
import { DEV_SIMULATOR } from "@/lib/devFlags";
import { useDeviceState } from "@/features/operations/useDeviceState";
import { useOnlineStatus } from "@/lib/useOnlineStatus";
import { ScrollingTabs } from "@/components/ScrollingTabs";
import { LanguageSwitch } from "@/components/LanguageSwitch";
import { useT } from "@/i18n/I18nProvider";
import type { TranslationKey } from "@/i18n/en";

export function AppLayout({ children }: { children: ReactNode }) {
  const t = useT();
  const { user, signOut } = useAuth();
  const { project, role, memberships, selectProject } = useProject();
  const { deviceOnline } = useDeviceState(project?.id);
  const online = useOnlineStatus();
  const location = useLocation();

  // role is null until memberships resolve, and `null !== "admin"` is
  // indistinguishable from "definitely not an admin" — so building the nav
  // eagerly rendered the three-tab non-admin set first, then swapped in the
  // six-tab admin set a moment later. The tabs an admin is reaching for moved
  // under their thumb mid-tap. Nothing is emitted until the answer is known.
  const roleKnown = role !== null;
  const links: { to: string; key: TranslationKey }[] = !roleKnown
    ? []
    : [
        { to: "/", key: "nav.operations" },
        ...(role === "admin"
          ? ([{ to: "/configure", key: "nav.configure" }] as const)
          : []),
        { to: "/explore", key: "nav.explore" },
        ...(role === "admin"
          ? ([
              { to: "/members", key: "nav.members" },
              { to: "/settings", key: "nav.settings" },
            ] as const)
          : []),
        ...(DEV_SIMULATOR
          ? ([{ to: "/simulator", key: "nav.simulator" }] as const)
          : []),
      ];

  return (
    <div>
      <header className="app-header">
        <div className="app-header__top">
          <span className="app-title">{project?.name ?? t("app.title")}</span>
          <span
            className={`dot ${deviceOnline ? "dot--online" : "dot--offline"}`}
            title={deviceOnline ? t("app.deviceOnline") : t("app.deviceOffline")}
            role="img"
            aria-label={
              deviceOnline ? t("app.deviceOnline") : t("app.deviceOffline")
            }
          />
          <div className="spacer" />
          <LanguageSwitch />
          <AccountMenu
            email={user?.email ?? ""}
            projectId={project?.id}
            memberships={memberships}
            selectProject={selectProject}
            signOut={() => void signOut()}
          />
        </div>

        <nav className="app-header__nav">
          <ScrollingTabs activeKey={location.pathname} ariaLabel={t("app.title")}>
            {roleKnown ? (
              links.map((l) => (
                <NavLink
                  key={l.to}
                  to={l.to}
                  end={l.to === "/"}
                  className="tab"
                  role="tab"
                >
                  {t(l.key)}
                </NavLink>
              ))
            ) : (
              // Holds the row's height while the role resolves. Without it the
              // header would collapse and then grow, trading a content shift
              // for a layout one. aria-hidden so it is never announced.
              <span className="tab" aria-hidden="true" style={{ visibility: "hidden" }}>
                {t("nav.operations")}
              </span>
            )}
          </ScrollingTabs>
        </nav>
      </header>

      {!online && (
        <div className="banner banner--warn" role="status">
          <span>{t("app.offline")}</span>
        </div>
      )}

      <main className="app-main">{children}</main>
    </div>
  );
}

interface AccountMenuProps {
  email: string;
  projectId: string | undefined;
  memberships: { projectId: string; name: string }[];
  selectProject: (id: string) => void;
  signOut: () => void;
}

// Holds everything that used to sit in the header competing for width: the
// email, the project switcher, the raw project id (a debugging aid, not
// everyday UI) and sign-out.
function AccountMenu({
  email,
  projectId,
  memberships,
  selectProject,
  signOut,
}: AccountMenuProps) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // Dismiss on outside click and on Escape — a menu that can only be closed
  // by its own button is a trap on touch devices.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="menu" ref={ref}>
      <button
        type="button"
        className="btn btn--ghost btn--sm"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label={t("app.account")}
      >
        <span aria-hidden="true">👤</span>
      </button>

      {open && (
        <div className="menu__panel" role="menu">
          <div className="menu__section">
            <span className="menu__email">{email}</span>
          </div>

          {memberships.length > 1 && (
            <div className="menu__section">
              <label className="field__label" htmlFor="project-switch">
                {t("app.switchProject")}
              </label>
              <select
                id="project-switch"
                className="input"
                value={projectId ?? ""}
                onChange={(e) => selectProject(e.target.value)}
              >
                {memberships.map((m) => (
                  <option key={m.projectId} value={m.projectId}>
                    {m.name}
                  </option>
                ))}
              </select>
            </div>
          )}

          {projectId && (
            <div className="menu__section">
              <span className="field__label">{t("app.projectId")}</span>
              <code className="ltr text-sm muted" style={{ userSelect: "all" }}>
                {projectId}
              </code>
            </div>
          )}

          <div className="menu__section">
            <button type="button" className="btn btn--sm" onClick={signOut}>
              {t("common.signOut")}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
