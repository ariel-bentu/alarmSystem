// Configure → Siren. Three cards, deliberately split by save behaviour:
//
//   1. enable toggle — a checkbox, so it saves on change (toast confirms)
//   2. pairing       — no save at all: a command/confirm handshake with the
//                      device, whose "save" is the siren's physical beep
//   3. siren config  — duration (a number) behind a Save button, plus the
//                      server-triggers-siren checkbox, which saves instantly
//
// Card 3 came from the old Settings page's "Siren & Server Alarm" card. The
// two alert-only fields that used to sit beside it (battery age, server sends
// notification) moved to the Notifications tab instead — neither touches the
// siren. See notifySettings.ts for the save model.
import { useState, useEffect } from "react";
import { onValue } from "firebase/database";
import { collection, addDoc, Timestamp, updateDoc } from "firebase/firestore";
import { set } from "firebase/database";
import { dbSync } from "@/lib/firebase";
import { commandsPairRef, stateSirenBaseRef } from "@/lib/rtdb";
import { buildPairCommand, formatSirenAddress } from "./sirenPairing";
import { useProject } from "@/app/ProjectProvider";
import { projectDoc } from "@/lib/firestore";
import { useT } from "@/i18n/I18nProvider";
import { useUnsavedChangesWarning } from "@/lib/useUnsavedChangesWarning";
import { useToast } from "@/lib/useToast";
import { type SirenForm, formFromProject, isDirty } from "./sirenSettings";

type PairingState =
  | "idle"
  | "sending"
  | "transmitting"
  | "confirming"
  | "paired"
  | "failed";

// How long the device transmits before we ask the user (ms).
// The device loops for 10s, then the poll-to-device latency can be up to 30s.
// We wait for the command to be picked up (~30s) then the transmit window (10s).
const TRANSMIT_WAIT_MS = 40_000;

export default function SirenTab() {
  const t = useT();
  const { project, reloadProject } = useProject();
  const projectId = project?.id ?? "";

  const { toast, showToast } = useToast();

  const [pairedAddress, setPairedAddress] = useState<number | null>(null);
  const [state, setState] = useState<PairingState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [sirenEnabled, setSirenEnabled] = useState<boolean>(
    project?.sirenEnabled !== false
  );
  const [savingEnabled, setSavingEnabled] = useState(false);

  // Card 3. `form` is deferred (duration); triggerSiren is a checkbox and
  // saves on change, so it is mirrored separately rather than held in `form`
  // — otherwise isDirty would report a change that is already persisted.
  const [saved, setSaved] = useState<SirenForm | null>(null);
  const [form, setForm] = useState<SirenForm | null>(null);
  const [savingConfig, setSavingConfig] = useState(false);
  const [configError, setConfigError] = useState<string | null>(null);
  const [triggerSiren, setTriggerSiren] = useState(false);
  const [savingTrigger, setSavingTrigger] = useState(false);

  useEffect(() => {
    setSirenEnabled(project?.sirenEnabled !== false);
  }, [project?.sirenEnabled]);

  // Deliberately does NOT depend on `form`: re-seeding mid-edit would discard
  // what the user is typing.
  useEffect(() => {
    if (!project) return;
    setSaved(formFromProject(project));
    setForm(formFromProject(project));
    setTriggerSiren(project.serverActions.triggerSiren === true);
  }, [project]);

  const dirty = saved !== null && form !== null && isDirty(saved, form);
  useUnsavedChangesWarning(dirty, t("settings.unsavedWarning"));

  const handleSaveConfig = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!projectId || !form || !dirty) return;
    setSavingConfig(true);
    setConfigError(null);
    try {
      await updateDoc(projectDoc(projectId), {
        sirenDurationSec: form.sirenDurationSec,
      });
      await reloadProject();
      setSaved(form);
      showToast(t("common.saved"));
    } catch (err) {
      setConfigError(
        err instanceof Error ? err.message : t("settings.saveFailed")
      );
    } finally {
      setSavingConfig(false);
    }
  };

  const handleToggleTrigger = async (next: boolean) => {
    if (!projectId || !project) return;
    const previous = triggerSiren;
    setTriggerSiren(next);
    setSavingTrigger(true);
    setConfigError(null);
    try {
      // Written whole: serverActions holds only these two keys, and a dotted
      // path would need updateDoc's field-path form.
      await updateDoc(projectDoc(projectId), {
        serverActions: { ...project.serverActions, triggerSiren: next },
      });
      await reloadProject();
      showToast(t("common.saved"));
    } catch (err) {
      // Revert: a checkbox left showing a state Firestore rejected would
      // misreport whether the server will sound the siren.
      setTriggerSiren(previous);
      setConfigError(
        err instanceof Error ? err.message : t("settings.saveFailed")
      );
    } finally {
      setSavingTrigger(false);
    }
  };

  useEffect(() => {
    if (!projectId) return;
    const r = stateSirenBaseRef(projectId);
    const unsub = onValue(r, (snap) => {
      const val = snap.val();
      setPairedAddress(typeof val === "number" ? val : null);
    });
    return () => unsub();
  }, [projectId]);

  const handleToggleEnabled = async () => {
    if (!projectId) return;
    setSavingEnabled(true);
    const next = !sirenEnabled;
    try {
      await updateDoc(projectDoc(projectId), { sirenEnabled: next });
      await reloadProject();
      showToast(t("common.saved"));
    } finally {
      setSavingEnabled(false);
    }
  };

  const handleStartPairing = async () => {
    if (!projectId) return;
    setError(null);
    setState("sending");
    try {
      await set(commandsPairRef(projectId), buildPairCommand(Date.now()));
      setState("transmitting");
      setTimeout(() => {
        setState("confirming");
      }, TRANSMIT_WAIT_MS);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setState("idle");
    }
  };

  const handleConfirmYes = async () => {
    if (!projectId) return;
    try {
      await addDoc(collection(dbSync(), "projects", projectId, "sirens"), {
        pairedAt: Timestamp.now(),
        baseAddress: pairedAddress,
      });
      setState("paired");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setState("confirming");
    }
  };

  const handleRetry = () => {
    setState("idle");
    setError(null);
  };

  return (
    <div>
      <section className="card">
        {/* No heading: the "Siren" sub-tab above already names this. */}
        <label className="check">
          <input
            type="checkbox"
            checked={sirenEnabled}
            disabled={savingEnabled}
            onChange={() => void handleToggleEnabled()}
          />
          <span>{t("cfg.siren.enabled")}</span>
        </label>
        {!sirenEnabled && (
          <p className="banner banner--warn">{t("cfg.siren.disabledWarn")}</p>
        )}

        <p className="muted">
          <strong>{t("cfg.siren.currentAddress")}</strong>{" "}
          <span className="ltr">{formatSirenAddress(pairedAddress)}</span>
        </p>
      </section>

      <section className="card">
        {state === "idle" && (
          <div className="stack">
            <p>{t("cfg.siren.pressSet")}</p>
            <p className="muted">{t("cfg.siren.deafWhileTx")}</p>
            {error && <p className="badge badge--danger">{error}</p>}
            <div>
              <button
                type="button"
                className="btn btn--primary"
                onClick={() => void handleStartPairing()}
              >
                {t("cfg.siren.sendPairing")}
              </button>
            </div>
          </div>
        )}

        {state === "sending" && <p>{t("cfg.siren.sending")}</p>}

        {state === "transmitting" && <p>{t("cfg.siren.transmitting")}</p>}

        {state === "confirming" && (
          <div className="stack">
            <p>{t("cfg.siren.beepTwice")}</p>
            <div className="row">
              <button
                type="button"
                className="btn btn--primary"
                onClick={() => void handleConfirmYes()}
              >
                {t("common.yes")}
              </button>
              <button
                type="button"
                className="btn"
                onClick={() => setState("failed")}
              >
                {t("cfg.siren.noTryAgain")}
              </button>
            </div>
          </div>
        )}

        {state === "paired" && (
          <div className="stack">
            <p>
              {t("cfg.siren.pairedOk")}{" "}
              <strong className="ltr">{formatSirenAddress(pairedAddress)}</strong>
            </p>
            <div>
              <button type="button" className="btn" onClick={handleRetry}>
                {t("cfg.siren.pairAgain")}
              </button>
            </div>
          </div>
        )}

        {state === "failed" && (
          <div className="stack">
            <p>{t("cfg.siren.pairFailed")}</p>
            <ul>
              <li>{t("cfg.siren.learnTimedOut")}</li>
              <li>{t("cfg.siren.pairFailOutOfRange")}</li>
            </ul>
            <div>
              <button type="button" className="btn btn--primary" onClick={handleRetry}>
                {t("cfg.siren.retry")}
              </button>
            </div>
          </div>
        )}
      </section>

      {/* Card 3: siren configuration, from the old Settings page. */}
      {form && (
        <form onSubmit={handleSaveConfig}>
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
                onChange={(e) => {
                  setForm({ sirenDurationSec: Number(e.target.value) });
                  setConfigError(null);
                }}
              />
            </div>

            <label className="check">
              <input
                type="checkbox"
                checked={triggerSiren}
                disabled={savingTrigger}
                onChange={(e) => void handleToggleTrigger(e.target.checked)}
              />
              <span>{t("settings.serverTriggersSiren")}</span>
            </label>

            {configError && (
              <p className="badge badge--danger" role="alert">
                {configError}
              </p>
            )}
            <div className="row">
              <button
                type="submit"
                className="btn btn--primary"
                disabled={savingConfig || !dirty}
                title={!dirty ? t("settings.noChanges") : undefined}
              >
                {savingConfig
                  ? t("common.saving")
                  : t("settings.saveSettings")}
              </button>
              {dirty && !savingConfig && (
                <span className="badge badge--warn">
                  {t("settings.unsavedBadge")}
                </span>
              )}
            </div>
          </section>
        </form>
      )}
      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
