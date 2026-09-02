import { useState, useEffect, useMemo } from "react";
import { onValue, ref, type DataSnapshot } from "firebase/database";
import { onSnapshot, addDoc, deleteDoc, Timestamp } from "firebase/firestore";
import { rtdbSync } from "@/lib/firebase";
import { remotesCol, remoteDoc } from "@/lib/firestore";
import { useProject } from "@/app/ProjectProvider";
import { useT } from "@/i18n/I18nProvider";
import type { Remote } from "@/types";
import {
  formatRemoteIdentity,
  identityFromEventRfId,
  REMOTE_BUTTON_LEGEND,
} from "./remotes";

// How long to watch /events for a button press after the user clicks Pair.
// Matches kRemotePairWindowMs in main.cpp (30s), plus headroom for the
// event to round-trip through RTDB.
const PAIR_WINDOW_MS = 40_000;

type PairState = "idle" | "listening" | "found" | "naming";

export default function RemotesTab() {
  const t = useT();
  const { project } = useProject();
  const projectId = project?.id ?? "";

  const [remotes, setRemotes] = useState<Remote[]>([]);
  const [eventIdentities, setEventIdentities] = useState<string[]>([]);
  const [pairState, setPairState] = useState<PairState>("idle");
  const [candidate, setCandidate] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [listenStartMs, setListenStartMs] = useState(0);

  // Paired remotes.
  useEffect(() => {
    if (!projectId) return;
    const unsub = onSnapshot(remotesCol(projectId), (snap) => {
      setRemotes(snap.docs.map((d) => ({ ...d.data(), id: d.id })));
    });
    return () => unsub();
  }, [projectId]);

  // Candidate identities seen on the air. Every button press lands in
  // /events as a full 24-bit code; identityFromEventRfId collapses the four
  // buttons of one remote onto a single identity.
  useEffect(() => {
    if (!projectId) return;
    const eventsRef = ref(rtdbSync(), `${projectId}/events`);
    const unsub = onValue(eventsRef, (snapshot: DataSnapshot) => {
      const val = snapshot.val() ?? {};
      const seen: string[] = [];
      for (const rfId of Object.keys(val)) {
        const identity = identityFromEventRfId(rfId);
        if (identity && !seen.includes(identity)) seen.push(identity);
      }
      setEventIdentities(seen);
    });
    return () => unsub();
  }, [projectId]);

  const pairedIdentities = useMemo(
    () => new Set(remotes.map((r) => formatRemoteIdentity(r.identity))),
    [remotes]
  );

  // While listening, the first unpaired identity to appear is the candidate.
  useEffect(() => {
    if (pairState !== "listening") return;
    const fresh = eventIdentities.find((id) => !pairedIdentities.has(id));
    if (fresh) {
      setCandidate(fresh);
      setPairState("found");
    }
  }, [pairState, eventIdentities, pairedIdentities]);

  // Give up after the window so the UI never sits on "listening" forever.
  useEffect(() => {
    if (pairState !== "listening") return;
    const timer = setTimeout(() => {
      setPairState("idle");
      setError(t("cfg.remotes.noPress"));
    }, PAIR_WINDOW_MS - (Date.now() - listenStartMs));
    return () => clearTimeout(timer);
  }, [pairState, listenStartMs, t]);

  const armed = project?.serverArmed === true;

  const startPairing = () => {
    setError(null);
    setCandidate(null);
    setName("");
    setListenStartMs(Date.now());
    setPairState("listening");
  };

  const savePairing = async () => {
    if (!projectId || !candidate) return;
    try {
      await addDoc(remotesCol(projectId), {
        identity: candidate,
        name: name.trim() || candidate,
        pairedAt: Timestamp.now(),
        lastSeen: null,
      } as Omit<Remote, "id">);
      setPairState("idle");
      setCandidate(null);
      setName("");
    } catch (e) {
      setError(String(e));
    }
  };

  const unpair = async (remoteId: string) => {
    if (!projectId) return;
    try {
      await deleteDoc(remoteDoc(projectId, remoteId));
    } catch (e) {
      setError(String(e));
    }
  };

  return (
    <div>
      <p className="muted">{t("cfg.remotes.intro")}</p>

      {error && <p role="alert">{error}</p>}

      {remotes.length === 0 && pairState === "idle" && (
        <p className="muted">{t("cfg.remotes.none")}</p>
      )}

      {remotes.length > 0 && (
        <table className="table">
          <thead>
            <tr>
              <th>{t("cfg.remotes.name")}</th>
              <th>{t("cfg.remotes.identity")}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {remotes.map((remote) => (
              <tr key={remote.id}>
                <td>{remote.name}</td>
                <td>
                  <code>{formatRemoteIdentity(remote.identity)}</code>
                </td>
                <td>
                  <button
                    type="button"
                    className="btn btn--sm"
                    onClick={() => unpair(remote.id)}
                  >
                    {t("cfg.remotes.unpair")}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {pairState === "idle" && (
        <>
          <button
            type="button"
            className="btn"
            onClick={startPairing}
            disabled={armed}
            title={armed ? t("cfg.remotes.armedBlocked") : undefined}
          >
            {t("cfg.remotes.pair")}
          </button>
          {/* The device refuses pairing while armed too; disabling here just
              avoids offering an action that will be rejected. */}
          {armed && <p className="muted">{t("cfg.remotes.armedBlocked")}</p>}
        </>
      )}

      {pairState === "listening" && (
        <p role="status">{t("cfg.remotes.pressAny")}</p>
      )}

      {pairState === "found" && candidate && (
        <div>
          <p role="status">
            {t("cfg.remotes.found")} <code>{candidate}</code>
          </p>
          <label>
            {t("cfg.remotes.name")}
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={candidate}
            />
          </label>
          <button type="button" className="btn" onClick={savePairing}>
            {t("cfg.remotes.save")}
          </button>
          <button
            type="button"
            className="btn btn--sm"
            onClick={() => setPairState("idle")}
          >
            {t("cfg.remotes.cancel")}
          </button>
        </div>
      )}

      {/* The mapping is fixed in firmware and not configurable, so it is
          documented rather than edited. */}
      <h3>{t("cfg.remotes.legend")}</h3>
      <table className="table">
        <tbody>
          {REMOTE_BUTTON_LEGEND.map((button) => (
            <tr key={button.nibble}>
              <td>{button.label}</td>
              <td className="muted">{button.action}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
