// Configure → Notifications: channels, credentials, and what gets notified.
//
// Note the asymmetry in where credentials live. Telegram's are fields on the
// project doc; Pushover's are in projects/{id}/secrets/notify, a subcollection
// that is ADMIN-ONLY rather than member-readable — a Pushover token decides
// who gets woken up, and the project doc is readable by every member. Both are
// editable here, but they are two different documents and two different Save
// buttons, so a failed credential write cannot roll back an unrelated setting.
//
// Save model: checkboxes and <select>s write on change (toast confirms); text
// and number fields are deferred behind a Save button. See notifySettings.ts.
import { useEffect, useState } from "react";
import { updateDoc, getDoc, setDoc } from "firebase/firestore";
import { useProject } from "@/app/ProjectProvider";
import { projectDoc, notifySecretsDoc } from "@/lib/firestore";
import { useT } from "@/i18n/I18nProvider";
import { useUnsavedChangesWarning } from "@/lib/useUnsavedChangesWarning";
import { useToast } from "@/lib/useToast";
import { Help } from "@/components/Help";
import {
  type NotifyForm,
  type NotifyChannel,
  type PushoverCredsForm,
  formFromProject,
  isDirty,
  credsFromSecrets,
  credsDirty,
  credsComplete,
  normalizeNotifyChannels,
  PUSHOVER_SOUNDS_LONG,
  PUSHOVER_SOUNDS_SHORT,
  RETRY_MIN_SEC,
  EXPIRE_MAX_SEC,
} from "./notifySettings";

export default function NotificationsTab() {
  const t = useT();
  const { project, reloadProject } = useProject();
  const { toast, showToast } = useToast();

  const [saved, setSaved] = useState<NotifyForm | null>(null);
  const [form, setForm] = useState<NotifyForm | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Instant-save controls. Mirrored in local state so each reflects an
  // in-flight write; not part of `form`, or isDirty would report changes that
  // are already persisted.
  const [channels, setChannels] = useState<NotifyChannel[]>([]);
  const [sound, setSound] = useState("");
  const [everyTrigger, setEveryTrigger] = useState(true);
  const [sendNotification, setSendNotification] = useState(false);
  const [busy, setBusy] = useState(false);

  // Pushover credentials: a separate document, so separate state and a
  // separate Save button. `null` means "not readable yet" — the read is in
  // flight or it failed — as distinct from a loaded pair of empty strings,
  // which means the read succeeded and nothing is stored. The inputs render
  // only in the second case, so a failed read cannot be saved over.
  const [savedCreds, setSavedCreds] = useState<PushoverCredsForm | null>(null);
  const [creds, setCreds] = useState<PushoverCredsForm | null>(null);
  const [credsSaving, setCredsSaving] = useState(false);
  const [credsError, setCredsError] = useState<string | null>(null);

  useEffect(() => {
    if (!project) return;
    setSaved(formFromProject(project));
    setForm(formFromProject(project));
    // Absent means ["telegram"] server-side, so the checkboxes must show that
    // rather than appearing to have nothing selected.
    setChannels(normalizeNotifyChannels(project.notifyChannels));
    // "" is a real choice (Pushover's own default tone), so absent maps to it
    // rather than to a sound we picked on the owner's behalf.
    setSound(project.pushoverSound ?? "");
    // Absent means enabled — a project predating the field must not read as
    // unchecked, which would silently turn notifications off.
    setEveryTrigger(project.notifyEverySensorTrigger !== false);
    setSendNotification(project.serverActions.sendNotification === true);
  }, [project]);

  // Read once per project, not live: a credential doc nobody else is editing
  // does not need a subscription, and a snapshot listener would overwrite
  // what the admin is typing on every unrelated write.
  useEffect(() => {
    if (!project) return;
    let cancelled = false;
    void (async () => {
      try {
        const snap = await getDoc(notifySecretsDoc(project.id));
        if (cancelled) return;
        const next = credsFromSecrets(snap.exists() ? snap.data() : {});
        setSavedCreds(next);
        setCreds(next);
      } catch (e) {
        if (cancelled) return;
        // A non-admin hits the rules and lands here. Treat it as "cannot
        // show", not "nothing stored": seeding the form with empty strings
        // would invite a save that wipes working credentials.
        setSavedCreds(null);
        setCreds(null);
        setCredsError(
          e instanceof Error ? e.message : t("settings.pushoverCredsLoadFailed")
        );
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [project, t]);

  const dirty = saved !== null && form !== null && isDirty(saved, form);
  const credsAreDirty =
    savedCreds !== null && creds !== null && credsDirty(savedCreds, creds);
  useUnsavedChangesWarning(
    dirty || credsAreDirty,
    t("settings.unsavedWarning")
  );

  if (!project || !form) return <div>{t("common.loading")}</div>;

  const setField = <K extends keyof NotifyForm>(
    key: K,
    value: NotifyForm[K]
  ) => {
    setForm((prev) => (prev ? { ...prev, [key]: value } : prev));
    setError(null);
  };

  // One write for any instant control, with revert-on-failure. Leaving a
  // checkbox showing a state Firestore rejected would misreport whether an
  // alert will actually be sent.
  const saveNow = async (patch: object, revert: () => void) => {
    setBusy(true);
    setError(null);
    try {
      await updateDoc(projectDoc(project.id), patch);
      await reloadProject();
      showToast(t("common.saved"));
    } catch (e) {
      revert();
      setError(e instanceof Error ? e.message : t("settings.saveFailed"));
    } finally {
      setBusy(false);
    }
  };

  // Routed through normalizeNotifyChannels so the stored order stays
  // canonical regardless of the order the boxes were ticked in.
  const toggleChannel = (channel: NotifyChannel, on: boolean) => {
    const previous = channels;
    const next = normalizeNotifyChannels(
      on ? [...channels, channel] : channels.filter((c) => c !== channel)
    );
    setChannels(next);
    void saveNow({ notifyChannels: next }, () => setChannels(previous));
  };

  // No FormEvent: this is wired to a plain button, not a submit, because the
  // card lives inside the page's main <form> and nesting one is invalid HTML.
  const handleSaveCreds = async () => {
    if (!creds || !credsAreDirty) return;
    setCredsSaving(true);
    setCredsError(null);
    try {
      const next: PushoverCredsForm = {
        appToken: creds.appToken.trim(),
        userKey: creds.userKey.trim(),
      };
      // merge: the doc may hold fields this form does not model.
      await setDoc(
        notifySecretsDoc(project.id),
        { pushoverToken: next.appToken, pushoverUserKey: next.userKey },
        { merge: true }
      );
      // Keep the non-secret mirror in step with the credentials themselves.
      // It is what the badge below reads, and what set:notifyKey writes — if
      // it drifted, the UI would claim Pushover is configured when it is not.
      // Requires BOTH halves: Pushover sends nothing with only one.
      await updateDoc(projectDoc(project.id), {
        pushoverConfigured: credsComplete(next),
      });
      await reloadProject();
      setSavedCreds(next);
      setCreds(next);
      showToast(t("common.saved"));
    } catch (err) {
      setCredsError(
        err instanceof Error ? err.message : t("settings.saveFailed")
      );
    } finally {
      setCredsSaving(false);
    }
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!dirty) return;
    setSaving(true);
    setError(null);
    try {
      const payload = {
        telegramBotToken: form.botToken.trim(),
        telegramChatId: form.chatId.trim(),
        pushoverRetrySec: form.pushoverRetrySec,
        pushoverExpireSec: form.pushoverExpireSec,
        batteryAlertMonths: form.batteryAlertMonths,
      };
      await updateDoc(projectDoc(project.id), payload);
      await reloadProject();
      // Baseline moves to the trimmed values actually written.
      const persisted: NotifyForm = {
        ...form,
        botToken: payload.telegramBotToken,
        chatId: payload.telegramChatId,
      };
      setSaved(persisted);
      setForm(persisted);
      showToast(t("common.saved"));
    } catch (err) {
      setError(err instanceof Error ? err.message : t("settings.saveFailed"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      <form onSubmit={handleSave}>
        {/* Channel selection. Pushover's credentials are edited further down,
            in their own card and their own form — they live in a different,
            admin-only document. */}
        <section className="card">
          <div className="field">
            <span className="field__label">{t("settings.notifyChannels")}</span>
            <label className="check">
              <input
                type="checkbox"
                checked={channels.includes("telegram")}
                disabled={busy}
                onChange={(e) => toggleChannel("telegram", e.target.checked)}
              />
              <span>{t("settings.channelTelegram")}</span>
            </label>
            <label className="check">
              <input
                type="checkbox"
                checked={channels.includes("pushover")}
                disabled={busy}
                onChange={(e) => toggleChannel("pushover", e.target.checked)}
              />
              <span>{t("settings.channelPushover")}</span>
              <Help
                text={t("settings.pushoverCriticalAlertsHint")}
                label={t("settings.help")}
              />
            </label>
            {/* An empty selection is a legitimate choice, not an error — but
                it silently disables every alert, so it is worth saying out
                loud. */}
            {channels.length === 0 && (
              <p className="badge badge--danger" role="status">
                {t("settings.notifyChannelsNone")}
              </p>
            )}
            {/* Warn on the PROBLEM only. There is deliberately no "all good"
                badge: the credential fields are visible further down this
                card, so a green "credentials are set" only restated what the
                user can already see. It existed when the credentials were
                CLI-only and genuinely invisible from the UI.

                Keyed off the live `creds` rather than the pushoverConfigured
                mirror, so it clears the moment the credentials are saved
                instead of waiting for the project doc to round-trip. Falls
                back to the mirror while the read is still in flight (or
                failed), which is the only time `creds` is null. */}
            {channels.includes("pushover") &&
              (creds === null
                ? !project.pushoverConfigured
                : !credsComplete(creds)) && (
                <p className="badge badge--danger" role="status">
                  {t("settings.pushoverNotConfigured")}
                </p>
              )}
          </div>
        </section>

        <section className="card">
          <div className="card__header">
            <h2 className="card__title">{t("settings.channelTelegram")}</h2>
          </div>
          <div className="field">
            <label className="field__label" htmlFor="bot-token">
              {t("settings.telegramBotToken")}
              <Help
                text={t("settings.botTokenHelp")}
                label={t("settings.help")}
              />
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
              <Help
                text={t("settings.chatIdHelp")}
                label={t("settings.help")}
              />
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
        </section>

        {/* Pushover-only options, shown only when that channel is on — they
            would be noise for a Telegram-only project.

            ONE card, credentials first: they are the prerequisite, and a
            second "Pushover" heading below the tuning fields read as a
            duplicate. The credentials still write to a DIFFERENT document
            (admin-only secrets/notify) with their own Save, which is a plain
            button rather than a submit — this card sits inside the page's
            main <form>, and a nested <form> is invalid HTML. */}
        {channels.includes("pushover") && (
          <section className="card">
            <div className="card__header">
              <h2 className="card__title">{t("settings.channelPushover")}</h2>
            </div>

            <p className="muted">{t("settings.pushoverCredentialsHelp")}</p>

            {creds === null ? (
              // The read failed or is still in flight. No inputs: seeding them
              // with empty strings would invite a save that wipes working
              // credentials.
              <p className="badge badge--danger" role="status">
                {credsError ?? t("common.loading")}
              </p>
            ) : (
              <>
                <div className="field">
                  <label className="field__label" htmlFor="pushover-app-token">
                    {t("settings.pushoverAppToken")}
                    <Help
                      text={t("settings.pushoverAppTokenHelp")}
                      label={t("settings.help")}
                    />
                  </label>
                  <input
                    id="pushover-app-token"
                    className="input ltr"
                    type="text"
                    value={creds.appToken}
                    onChange={(e) => {
                      setCreds({ ...creds, appToken: e.target.value });
                      setCredsError(null);
                    }}
                    placeholder="azGDORePK8gMaC0QOYAMyEEuzJnyUi"
                  />
                </div>

                <div className="field">
                  <label className="field__label" htmlFor="pushover-user-key">
                    {t("settings.pushoverUserKey")}
                    <Help
                      text={t("settings.pushoverUserKeyHelp")}
                      label={t("settings.help")}
                    />
                  </label>
                  <input
                    id="pushover-user-key"
                    className="input ltr"
                    type="text"
                    value={creds.userKey}
                    onChange={(e) => {
                      setCreds({ ...creds, userKey: e.target.value });
                      setCredsError(null);
                    }}
                    placeholder="uQiRzpo4DXghDmr9QzzfQu27cmVRsG"
                  />
                </div>

                {/* Pushover needs BOTH halves; one alone sends nothing. */}
                {!credsComplete(creds) &&
                  (creds.appToken.trim() !== "" ||
                    creds.userKey.trim() !== "") && (
                    <p className="badge badge--warn" role="status">
                      {t("settings.pushoverCredsIncomplete")}
                    </p>
                  )}

                {credsError && (
                  <p className="badge badge--danger" role="alert">
                    {credsError}
                  </p>
                )}

                {/* type="button": submitting would trigger the OUTER form's
                    handler, saving the project doc instead of the secrets. */}
                <div className="row">
                  <button
                    type="button"
                    className="btn"
                    disabled={credsSaving || !credsAreDirty}
                    title={!credsAreDirty ? t("settings.noChanges") : undefined}
                    onClick={() => void handleSaveCreds()}
                  >
                    {credsSaving
                      ? t("common.saving")
                      : t("settings.savePushoverCreds")}
                  </button>
                  {credsAreDirty && !credsSaving && (
                    <span className="badge badge--warn">
                      {t("settings.unsavedBadge")}
                    </span>
                  )}
                </div>
              </>
            )}

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
                value={sound}
                disabled={busy}
                onChange={(e) => {
                  const previous = sound;
                  const next = e.target.value;
                  setSound(next);
                  void saveNow({ pushoverSound: next }, () =>
                    setSound(previous)
                  );
                }}
              >
                <option value="">{t("settings.pushoverSoundDefault")}</option>
                {/* Long sounds first and labelled: an emergency alert
                    re-sends every `retry` seconds rather than sustaining a
                    tone, so a short sound is the reason one can fail to feel
                    like an alarm. */}
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
          </section>
        )}

        <section className="card">
          <div className="card__header">
            <h2 className="card__title">{t("settings.whatToNotify")}</h2>
          </div>
          <label className="check">
            <input
              type="checkbox"
              checked={everyTrigger}
              disabled={busy}
              onChange={(e) => {
                const previous = everyTrigger;
                const next = e.target.checked;
                setEveryTrigger(next);
                void saveNow({ notifyEverySensorTrigger: next }, () =>
                  setEveryTrigger(previous)
                );
              }}
            />
            <span>{t("settings.notifyEveryTrigger")}</span>
          </label>

          <label className="check">
            <input
              type="checkbox"
              checked={sendNotification}
              disabled={busy}
              onChange={(e) => {
                const previous = sendNotification;
                const next = e.target.checked;
                setSendNotification(next);
                // Nested field: written whole, since serverActions holds only
                // these two keys and a dotted path would need updateDoc's
                // field-path form.
                void saveNow(
                  {
                    serverActions: {
                      ...project.serverActions,
                      sendNotification: next,
                    },
                  },
                  () => setSendNotification(previous)
                );
              }}
            />
            <span>{t("settings.serverSendsNotification")}</span>
            <Help
              text={t("settings.serverSendsNotificationHelp")}
              label={t("settings.help")}
            />
          </label>

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
