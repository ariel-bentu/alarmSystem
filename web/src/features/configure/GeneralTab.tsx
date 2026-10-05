// Configure → General: project name and timezone.
//
// Was the first (unlabelled) card of the old Settings page, which this tab
// replaces along with Notifications and the Siren tab's third card.
import { useEffect, useState } from "react";
import { updateDoc } from "firebase/firestore";
import { useProject } from "@/app/ProjectProvider";
import { projectDoc } from "@/lib/firestore";
import { useT } from "@/i18n/I18nProvider";
import { useUnsavedChangesWarning } from "@/lib/useUnsavedChangesWarning";
import { useToast } from "@/lib/useToast";
import { Help } from "@/components/Help";
import { type GeneralForm, formFromProject, isDirty } from "./generalSettings";

/** IANA zones for the picker, with the project's current value guaranteed
 *  present. Without that union a zone this browser does not enumerate would
 *  not match any <option>, and the select would render as the first entry —
 *  silently rewriting the saved zone on the next save. */
function timezoneOptions(current: string): string[] {
  const all =
    typeof Intl.supportedValuesOf === "function"
      ? Intl.supportedValuesOf("timeZone")
      : [];
  return all.includes(current) ? all : [current, ...all];
}

export default function GeneralTab() {
  const t = useT();
  const { project, reloadProject } = useProject();
  const { toast, showToast } = useToast();

  // Two copies: `saved` is what Firestore last confirmed, `form` is what the
  // user is editing. Comparing them is what makes "have I got unsaved edits?"
  // a real question — which is the whole point of having a Save button.
  const [saved, setSaved] = useState<GeneralForm | null>(null);
  const [form, setForm] = useState<GeneralForm | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The timezone <select> saves on change, so it is not part of `form`. It is
  // mirrored here only so the control reflects an in-flight write.
  const [timezone, setTimezone] = useState("");
  const [savingTz, setSavingTz] = useState(false);

  // Deliberately does NOT depend on `form`: re-seeding mid-edit would discard
  // what the user is typing.
  useEffect(() => {
    if (!project) return;
    setSaved(formFromProject(project));
    setForm(formFromProject(project));
    // Projects predating the field fall back to the BROWSER's zone, not UTC.
    // Offering UTC would invite the user to save it, producing exactly the
    // silent hour-long schedule drift the zone exists to prevent; the
    // browser's zone is almost always right, since the alarm is in the house
    // they are in.
    setTimezone(
      project.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone
    );
  }, [project]);

  const dirty = saved !== null && form !== null && isDirty(saved, form);
  useUnsavedChangesWarning(dirty, t("settings.unsavedWarning"));

  if (!project || !form) return <div>{t("common.loading")}</div>;

  const handleTimezone = async (next: string) => {
    const previous = timezone;
    setTimezone(next);
    setSavingTz(true);
    setError(null);
    try {
      await updateDoc(projectDoc(project.id), { timezone: next });
      await reloadProject();
      showToast(t("common.saved"));
    } catch (e) {
      // Revert: leaving the control showing a value Firestore rejected would
      // misreport which zone the schedules actually resolve in.
      setTimezone(previous);
      setError(e instanceof Error ? e.message : t("settings.saveFailed"));
    } finally {
      setSavingTz(false);
    }
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!dirty) return;
    setSaving(true);
    setError(null);
    try {
      const name = form.name.trim();
      await updateDoc(projectDoc(project.id), { name });
      await reloadProject();
      // Baseline moves to the TRIMMED value actually written, so the form is
      // clean immediately rather than waiting for the doc to round-trip.
      setSaved({ name });
      setForm({ name });
      showToast(t("common.saved"));
    } catch (err) {
      setError(err instanceof Error ? err.message : t("settings.saveFailed"));
    } finally {
      setSaving(false);
    }
  };

  const timezones = timezoneOptions(timezone);

  return (
    <div>
      <form onSubmit={handleSave}>
        <section className="card">
          <div className="field">
            <label className="field__label" htmlFor="project-name">
              {t("settings.projectName")}
            </label>
            <input
              id="project-name"
              className="input"
              type="text"
              value={form.name}
              onChange={(e) => {
                setForm({ name: e.target.value });
                setError(null);
              }}
              required
            />
          </div>

          <div className="field">
            <label className="field__label" htmlFor="project-timezone">
              {t("settings.timezone")}
              <Help
                text={t("settings.timezoneHelp")}
                label={t("settings.help")}
              />
            </label>
            {/* A select, not a text input: a typo'd zone name would fall back
                to UTC on the server and shift every schedule by hours without
                any visible error. Picking from the real IANA list makes that
                unrepresentable. */}
            <select
              id="project-timezone"
              className="input"
              value={timezone}
              disabled={savingTz}
              onChange={(e) => void handleTimezone(e.target.value)}
            >
              {timezones.map((tz) => (
                <option key={tz} value={tz}>
                  {tz}
                </option>
              ))}
            </select>
          </div>
        </section>

        {error && (
          <p className="badge badge--danger" role="alert">
            {error}
          </p>
        )}
        <div className="row">
          <button
            type="submit"
            className="btn btn--primary"
            disabled={saving || !dirty}
            title={!dirty ? t("settings.noChanges") : undefined}
          >
            {saving ? t("common.saving") : t("settings.saveSettings")}
          </button>
          {dirty && !saving && (
            <span className="badge badge--warn">
              {t("settings.unsavedBadge")}
            </span>
          )}
        </div>
      </form>
      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
