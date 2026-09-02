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

  const [pairedAddress, setPairedAddress] = useState<number | null>(null);
  const [state, setState] = useState<PairingState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [sirenEnabled, setSirenEnabled] = useState<boolean>(
    project?.sirenEnabled !== false
  );
  const [savingEnabled, setSavingEnabled] = useState(false);

  useEffect(() => {
    setSirenEnabled(project?.sirenEnabled !== false);
  }, [project?.sirenEnabled]);

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
    </div>
  );
}
