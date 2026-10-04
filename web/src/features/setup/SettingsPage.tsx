// Project settings (admin-only): edit name, Telegram bot token + chat id,
// notification channels, siren duration, and server alarm actions. Writes to
// the project doc (rules allow admin updates).
//
// Note the asymmetry: Telegram's credentials are fields here, but Pushover's
// are NOT — they live in projects/{id}/secrets/notify, denied to every
// client, and are written by `npm run set:notifyKey`. This page can only
// report whether they exist, via the non-secret pushoverConfigured mirror.
import { useEffect, useState } from "react";
import { updateDoc } from "firebase/firestore";
import { useProject } from "@/app/ProjectProvider";
import { projectDoc } from "@/lib/firestore";
import { useT } from "@/i18n/I18nProvider";
import { useUnsavedChangesWarning } from "@/lib/useUnsavedChangesWarning";
import {
  type SettingsForm,
  type NotifyChannel,
  formFromProject,
  isDirty,
  normalizeNotifyChannels,
  PUSHOVER_SOUNDS_LONG,
  PUSHOVER_SOUNDS_SHORT,
  RETRY_MIN_SEC,
  EXPIRE_MAX_SEC,
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

  // Tick/untick one channel. Routed through normalizeNotifyChannels so the
  // stored order stays canonical — isDirty compares the two lists by value,
  // and an unstable order would read as an edit.
  const toggleChannel = (channel: NotifyChannel, on: boolean) => {
    const next = on
      ? [...form.notifyChannels, channel]
      : form.notifyChannels.filter((c) => c !== channel);
    setField("notifyChannels", normalizeNotifyChannels(next));
  };

  const timezones = timezoneOptions(form.timezone);

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
        batteryAlertMonths: form.batteryAlertMonths,
        timezone: form.timezone,
        notifyEverySensorTrigger: form.notifyEverySensorTrigger,
        notifyChannels: form.notifyChannels,
        pushoverSound: form.pushoverSound,
        pushoverRetrySec: form.pushoverRetrySec,
        pushoverExpireSec: form.pushoverExpireSec,
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
              value={form.timezone}
              onChange={(e) => setField("timezone", e.target.value)}
            >
              {timezones.map((tz) => (
                <option key={tz} value={tz}>
                  {tz}
                </option>
              ))}
            </select>
          </div>
        </section>

        <section className="card">
          <div className="card__header">
            <h2 className="card__title">{t("settings.notifications")}</h2>
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

          {/* Channel selection. The Pushover CREDENTIALS deliberately have no
              input here — they live in a server-only Firestore subcollection
              that no client may read, written by `npm run set:notifyKey`. All
              this page can do is report whether they are present. */}
          <div className="field">
            <span className="field__label">{t("settings.notifyChannels")}</span>
            <label className="check">
              <input
                type="checkbox"
                checked={form.notifyChannels.includes("telegram")}
                onChange={(e) => toggleChannel("telegram", e.target.checked)}
              />
              <span>{t("settings.channelTelegram")}</span>
            </label>
            <label className="check">
              <input
                type="checkbox"
                checked={form.notifyChannels.includes("pushover")}
                onChange={(e) => toggleChannel("pushover", e.target.checked)}
              />
              <span>{t("settings.channelPushover")}</span>
              <Help
                text={t("settings.pushoverCriticalAlertsHint")}
                label={t("settings.help")}
              />
            </label>
            {/* An empty selection is a legitimate choice, not an error — but
                it silently disables every alert, so it is worth saying out loud. */}
            {form.notifyChannels.length === 0 && (
              <p className="badge badge--danger" role="status">
                {t("settings.notifyChannelsNone")}
              </p>
            )}
            {form.notifyChannels.includes("pushover") &&
              (project.pushoverConfigured ? (
                <p className="badge badge--ok" role="status">
                  {t("settings.pushoverConfigured")}
                </p>
              ) : (
                <p className="badge badge--danger" role="status">
                  {t("settings.pushoverNotConfigured")}
                </p>
              ))}
          </div>

          {/* Pushover-only options, shown only when that channel is on —
              they would be noise for a Telegram-only project. */}
          {form.notifyChannels.includes("pushover") && (
            <>
              <div className="field">
                <label className="field__label" htmlFor="pushover-sound">
                  {t("settings.pushoverSound")}
                  <Help
                    text={t("settings.pushoverSoundHelp")}
                    label={t("settings.help")}
                  />
                </label>
                <select
                  id="pushover-sound"
                  className="input"
                  value={form.pushoverSound}
                  onChange={(e) => setField("pushoverSound", e.target.value)}
                >
                  <option value="">{t("settings.pushoverSoundDefault")}</option>
                  {/* Long sounds first and labelled: an emergency alert
                      re-sends every `retry` seconds rather than sustaining a
                      tone, so a short sound is the reason one can fail to
                      feel like an alarm. */}
                  <optgroup label={t("settings.pushoverSoundLong")}>
                    {PUSHOVER_SOUNDS_LONG.map((s) => (
                      <option key={s} value={s}>
                        {s}
                      </option>
                    ))}
                  </optgroup>
                  <optgroup label={t("settings.pushoverSoundShort")}>
                    {PUSHOVER_SOUNDS_SHORT.map((s) => (
                      <option key={s} value={s}>
                        {s}
                      </option>
                    ))}
                  </optgroup>
                </select>
              </div>

              <div className="field">
                <label className="field__label" htmlFor="pushover-retry">
                  {t("settings.pushoverRetry")}
                  <Help
                    text={t("settings.pushoverRetryHelp")}
                    label={t("settings.help")}
                  />
                </label>
                <input
                  id="pushover-retry"
                  className="input"
                  type="number"
                  min={RETRY_MIN_SEC}
                  value={form.pushoverRetrySec}
                  onChange={(e) =>
                    setField("pushoverRetrySec", Number(e.target.value))
                  }
                />
              </div>

              <div className="field">
                <label className="field__label" htmlFor="pushover-expire">
                  {t("settings.pushoverExpire")}
                  <Help
                    text={t("settings.pushoverExpireHelp")}
                    label={t("settings.help")}
                  />
                </label>
                <input
                  id="pushover-expire"
                  className="input"
                  type="number"
                  min={RETRY_MIN_SEC}
                  max={EXPIRE_MAX_SEC}
                  value={form.pushoverExpireSec}
                  onChange={(e) =>
                    setField("pushoverExpireSec", Number(e.target.value))
                  }
                />
              </div>
            </>
          )}
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

          <div className="field">
            <label className="field__label" htmlFor="battery-alert-months">
              {t("settings.batteryAlertMonths")}
              <Help
                text={t("settings.batteryAlertMonthsHelp")}
                label={t("settings.help")}
              />
            </label>
            <input
              id="battery-alert-months"
              className="input input--narrow"
              type="number"
              min={0}
              value={form.batteryAlertMonths}
              onChange={(e) =>
                setField("batteryAlertMonths", Number(e.target.value))
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
