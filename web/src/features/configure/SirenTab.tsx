import { useState, useEffect } from "react";
import { onValue } from "firebase/database";
import { collection, addDoc, Timestamp, updateDoc } from "firebase/firestore";
import { set } from "firebase/database";
import { db } from "@/lib/firebase";
import { commandsPairRef, stateSirenBaseRef } from "@/lib/rtdb";
import { buildPairCommand, formatSirenAddress } from "./sirenPairing";
import { useProject } from "@/app/ProjectProvider";
import { projectDoc } from "@/lib/firestore";

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
      await addDoc(collection(db, "projects", projectId, "sirens"), {
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
      <h2>Siren</h2>

      <div style={{ marginBottom: 16 }}>
        <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
          <input
            type="checkbox"
            checked={sirenEnabled}
            disabled={savingEnabled}
            onChange={() => void handleToggleEnabled()}
          />
          <span>Siren enabled</span>
        </label>
        {!sirenEnabled && (
          <p style={{ color: "#b45309", fontSize: 13, margin: "4px 0 0" }}>
            Siren is disabled — the device will evaluate alarm rules but never
            sound the siren or fire the relay.
          </p>
        )}
      </div>

      <p style={{ opacity: 0.8, fontSize: 13 }}>
        <strong>Current paired address:</strong>{" "}
        {formatSirenAddress(pairedAddress)}
      </p>

      {state === "idle" && (
        <div>
          <p>
            Press SET on the siren until its lights come on, then click{" "}
            <strong>Send pairing signal</strong>.
          </p>
          <p style={{ color: "#b45309", fontSize: 13 }}>
            The alarm cannot detect sensors while it is transmitting (about 10
            seconds).
          </p>
          {error && <p style={{ color: "red" }}>{error}</p>}
          <button type="button" onClick={() => void handleStartPairing()}>
            Send pairing signal
          </button>
        </div>
      )}

      {state === "sending" && (
        <p>Sending pairing command to device&hellip;</p>
      )}

      {state === "transmitting" && (
        <p>
          Waiting for device (up to 30&nbsp;s), then transmitting for
          10&nbsp;s&mdash;the siren should beep twice.
        </p>
      )}

      {state === "confirming" && (
        <div>
          <p>Did the siren beep twice?</p>
          <button
            type="button"
            style={{ marginRight: 8 }}
            onClick={() => void handleConfirmYes()}
          >
            Yes
          </button>
          <button type="button" onClick={() => setState("failed")}>
            No, try again
          </button>
        </div>
      )}

      {state === "paired" && (
        <div>
          <p>
            Siren paired successfully. Address:{" "}
            <strong>{formatSirenAddress(pairedAddress)}</strong>
          </p>
          <button type="button" onClick={handleRetry}>
            Pair again
          </button>
        </div>
      )}

      {state === "failed" && (
        <div>
          <p>Pairing did not succeed. Likely causes:</p>
          <ul>
            <li>
              Learn mode may have timed out&mdash;press SET again immediately
              before retrying.
            </li>
            <li>The siren may be out of range of the alarm device.</li>
          </ul>
          <button type="button" onClick={handleRetry}>
            Retry
          </button>
        </div>
      )}
    </div>
  );
}

