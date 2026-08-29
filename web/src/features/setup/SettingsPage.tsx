// Project settings (admin-only): edit name, Telegram bot token + chat id,
// siren duration, and server alarm actions. Writes to the project doc
// (rules allow admin updates).
import { useEffect, useState } from "react";
import { updateDoc } from "firebase/firestore";
import { useProject } from "@/app/ProjectProvider";
import { projectDoc } from "@/lib/firestore";
import { useT } from "@/i18n/I18nProvider";
import { useUnsavedChangesWarning } from "@/lib/useUnsavedChangesWarning";
import {
  type SettingsForm,
  formFromProject,
  isDirty,
} from "./settingsForm";

// Inline help marker: a "?" button that toggles a visible instruction panel on
// click (native title tooltips are unreliable, so we render our own).
function Help({ text, label }: { text: string; label: string }) {
  const [open, setOpen] = useState(false);
  return (
    <span className="help">
      <button
        type="button"
        className="help__btn"
        aria-label={label}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        ?
      </button>
      {open && (
        <span role="tooltip" className="help__panel">
          {text}
        </span>
      )}
    </span>
  );
}

export default function SettingsPage() {
  const t = useT();
  const { project, role, reloadProject } = useProject();

  // Two copies: `saved` is what Firestore last confirmed, `form` is what the
  // user is editing. Comparing them is what makes "unsaved changes" knowable —
  // which is the whole point of having a Save button.
  const [saved, setSaved] = useState<SettingsForm | null>(null);
  const [form, setForm] = useState<SettingsForm | null>(null);

  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Populate from the loaded project. Deliberately does NOT depend on `form`:
  // re-seeding mid-edit would discard what the user is typing.
  useEffect(() => {
    if (!project) return;
    const next = formFromProject(project);
    setSaved(next);
    setForm(next);
  }, [project]);

  const dirty = saved !== null && form !== null && isDirty(saved, form);

  // Covers both tab close and in-app navigation.
  useUnsavedChangesWarning(dirty, t("settings.unsavedWarning"));

  if (!project || !form) return <div>{t("common.loading")}</div>;
  if (role !== "admin") return <div>{t("settings.adminRequired")}</div>;

  // Typed field setter so each control stays a one-liner.
  const setField = <K extends keyof SettingsForm>(
    key: K,
    value: SettingsForm[K]
  ) => {
    setForm((prev) => (prev ? { ...prev, [key]: value } : prev));
    setNotice(null);
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!dirty) return;
    setSaving(true);
    setNotice(null);
    setError(null);
    try {
      const payload = {
        name: form.name.trim(),
        telegramBotToken: form.botToken.trim(),
        telegramChatId: form.chatId.trim(),
        sirenDurationSec: form.sirenDurationSec,
        notifyEverySensorTrigger: form.notifyEverySensorTrigger,
        serverActions: {
          sendTelegram: form.sendTelegram,
          triggerSiren: form.triggerSiren,
        },
      };
      await updateDoc(projectDoc(project.id), payload);
      await reloadProject();
      // Baseline moves to the trimmed values actually written, so the form is
      // clean immediately rather than waiting for the project doc to round-trip.
      const persisted: SettingsForm = {
        ...form,
        name: payload.name,
        botToken: payload.telegramBotToken,
        chatId: payload.telegramChatId,
      };
      setSaved(persisted);
      setForm(persisted);
      setNotice(t("common.saved"));
    } catch (err) {
      setError(err instanceof Error ? err.message : t("settings.saveFailed"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      <h1 className="sr-only">{t("settings.title")}</h1>
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
              onChange={(e) => setField("name", e.target.value)}
              required
            />
          </div>
        </section>

        <section className="card">
          <div className="card__header">
            <h2 className="card__title">{t("settings.telegram")}</h2>
          </div>
          <div className="field">
            <label className="field__label" htmlFor="bot-token">
              {t("settings.telegramBotToken")}
              <Help text={t("settings.botTokenHelp")} label={t("settings.help")} />
            </label>
            <input
              id="bot-token"
              className="input ltr"
              type="text"
              value={form.botToken}
              onChange={(e) => setField("botToken", e.target.value)}
              placeholder="123456:ABC-DEF..."
            />
          </div>
          <div className="field">
            <label className="field__label" htmlFor="chat-id">
              {t("settings.telegramChatId")}
              <Help text={t("settings.chatIdHelp")} label={t("settings.help")} />
            </label>
            <input
              id="chat-id"
              className="input ltr"
              type="text"
              value={form.chatId}
              onChange={(e) => setField("chatId", e.target.value)}
              placeholder="-1001234567890"
            />
          </div>

          <label className="check">
            <input
              type="checkbox"
              checked={form.notifyEverySensorTrigger}
              onChange={(e) =>
                setField("notifyEverySensorTrigger", e.target.checked)
              }
            />
            <span>{t("settings.notifyEveryTrigger")}</span>
          </label>
        </section>

        <section className="card">
          <div className="card__header">
            <h2 className="card__title">{t("settings.sirenAndAlarm")}</h2>
          </div>
          <div className="field">
            <label className="field__label" htmlFor="siren-duration">
              {t("settings.sirenDuration")}
            </label>
            <input
              id="siren-duration"
              className="input input--narrow"
              type="number"
              min={0}
              value={form.sirenDurationSec}
              onChange={(e) =>
                setField("sirenDurationSec", Number(e.target.value))
              }
            />
          </div>

          <label className="check">
            <input
              type="checkbox"
              checked={form.sendTelegram}
              onChange={(e) => setField("sendTelegram", e.target.checked)}
            />
            <span>{t("settings.serverSendsTelegram")}</span>
          </label>

          <label className="check">
            <input
              type="checkbox"
              checked={form.triggerSiren}
              onChange={(e) => setField("triggerSiren", e.target.checked)}
            />
            <span>{t("settings.serverTriggersSiren")}</span>
          </label>
        </section>

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
    </div>
  );
}
