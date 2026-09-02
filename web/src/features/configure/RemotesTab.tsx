import { useState, useEffect } from "react";
import { ref, onValue, type DataSnapshot } from "firebase/database";
import { onSnapshot, addDoc, deleteDoc, Timestamp } from "firebase/firestore";
import { rtdbSync } from "@/lib/firebase";
import { remotesCol, remoteDoc } from "@/lib/firestore";
import { useProject } from "@/app/ProjectProvider";
import { useDeviceState } from "@/features/operations/useDeviceState";
import { useT } from "@/i18n/I18nProvider";
import type { Remote } from "@/types";
import { isJustSeen, type EventTiming } from "./sensorRecency";
import { formatRelative } from "./lastSeenFormat";
import {
  formatRemoteIdentity,
  groupCandidatesByIdentity,
  REMOTE_BUTTON_LEGEND,
} from "./remotes";

export default function RemotesTab() {
  const t = useT();
  const { project } = useProject();
  const projectId = project?.id ?? "";
  const { armed: deviceArmed } = useDeviceState(projectId);

  const [remotes, setRemotes] = useState<Remote[]>([]);
  const [eventTiming, setEventTiming] = useState<Record<string, EventTiming>>({});
  const [now, setNow] = useState(() => Date.now());
  const [pairIdentity, setPairIdentity] = useState<string | null>(null);
  const [pairName, setPairName] = useState("");
  const [error, setError] = useState<string | null>(null);

  // Same 10s cadence as SensorsTab so the "just seen" dot decays visibly.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 10_000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    if (!projectId) return;
    const unsub = onSnapshot(remotesCol(projectId), (snap) => {
      setRemotes(snap.docs.map((d) => ({ ...d.data(), id: d.id })));
    });
    return () => unsub();
  }, [projectId]);

  // Same RTDB events subscription the sensors tab uses — a remote button
  // press lands there exactly like a sensor trigger.
  useEffect(() => {
    if (!projectId) return;
    const eventsRef = ref(rtdbSync(), `${projectId}/events`);
    const unsub = onValue(eventsRef, (snapshot: DataSnapshot) => {
      const val = snapshot.val();
      const timing: Record<string, EventTiming> = {};
      if (val && typeof val === "object") {
        for (const [rfId, events] of Object.entries(
          val as Record<string, Record<string, unknown>>
        )) {
          const tsKeys = Object.keys(events ?? {})
            .map(Number)
            .filter((n) => !Number.isNaN(n));
          if (tsKeys.length === 0) continue;
          timing[rfId] = {
            firstSeen: Math.min(...tsKeys),
            lastSeen: Math.max(...tsKeys),
            count: tsKeys.length,
          };
        }
      }
      setEventTiming(timing);
    });
    return () => unsub();
  }, [projectId]);

  // One candidate per REMOTE, not per button: the four buttons of one keyfob
  // are four different codes sharing a 20-bit identity.
  const candidates = groupCandidatesByIdentity(
    eventTiming,
    remotes.map((r) => r.identity)
  );

  // The DEVICE's arm state, live from RTDB — not project.serverArmed, which
  // is the separate server-side flag AND is a one-shot getDoc that goes
  // stale (see OperationsPage). Pairing is refused by the device based on
  // its own arm state, so the UI has to check the same thing.
  const armed = deviceArmed === true;

  const handlePair = async () => {
    if (!pairIdentity || !pairName.trim() || !projectId) return;
    try {
      await addDoc(remotesCol(projectId), {
        identity: pairIdentity,
        name: pairName.trim(),
        pairedAt: Timestamp.now(),
        lastSeen: null,
      } as Omit<Remote, "id">);
      setPairIdentity(null);
      setPairName("");
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  };

  const handleUnpair = async (remoteId: string) => {
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

      <h3>{t("cfg.remotes.paired")}</h3>
      {remotes.length === 0 ? (
        <p className="muted">{t("cfg.remotes.none")}</p>
      ) : (
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
                  <span className="ltr">
                    {formatRemoteIdentity(remote.identity)}
                  </span>
                </td>
                <td>
                  <button
                    className="btn btn--sm"
                    onClick={() => handleUnpair(remote.id)}
                  >
                    {t("cfg.remotes.unpair")}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h3>{t("cfg.remotes.unrecognised")}</h3>
      <p className="muted">{t("cfg.remotes.pressHint")}</p>
      {/* Shown ABOVE the table, not only as a disabled-button tooltip: a
          button that does nothing on click reads as broken. */}
      {armed && <p role="status">{t("cfg.remotes.armedBlocked")}</p>}
      {candidates.length === 0 ? (
        <p className="muted">{t("cfg.remotes.noCandidates")}</p>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>{t("cfg.remotes.identity")}</th>
              <th>{t("cfg.remotes.buttonsSeen")}</th>
              <th>{t("cfg.remotes.lastSeen")}</th>
              <th>{t("cfg.remotes.events")}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {candidates.map((candidate) => {
              const justSeen = isJustSeen(candidate.lastSeen, now);
              return (
                <tr
                  key={candidate.identity}
                  className={justSeen ? "is-fresh" : undefined}
                >
                  <td>
                    {justSeen && <span className="dot dot--fresh" />}
                    <span className="ltr">{candidate.identity}</span>
                  </td>
                  {/* How many DISTINCT buttons we have heard. A real remote
                      reaches 4; a single-button sensor stays at 1, which is
                      the clearest signal that a candidate is not a remote. */}
                  <td>{candidate.codes.length}</td>
                  <td>{formatRelative(candidate.lastSeen, now, t)}</td>
                  <td>{candidate.count}</td>
                  <td>
                    <button
                      className="btn btn--sm btn--primary"
                      disabled={armed}
                      title={
                        armed ? t("cfg.remotes.armedBlocked") : undefined
                      }
                      onClick={() => {
                        setPairIdentity(candidate.identity);
                        setPairName("");
                      }}
                    >
                      {t("cfg.remotes.pair")}
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      {pairIdentity && (
        <div>
          <h3>
            {t("cfg.remotes.pairing")}{" "}
            <span className="ltr">{pairIdentity}</span>
          </h3>
          <label>
            {t("cfg.remotes.name")}
            <input
              type="text"
              value={pairName}
              onChange={(e) => setPairName(e.target.value)}
              placeholder={pairIdentity}
            />
          </label>
          <button
            className="btn btn--primary"
            onClick={handlePair}
            disabled={!pairName.trim()}
          >
            {t("cfg.remotes.save")}
          </button>
          <button className="btn btn--sm" onClick={() => setPairIdentity(null)}>
            {t("cfg.remotes.cancel")}
          </button>
        </div>
      )}

      {/* Fixed in firmware (remote_control.cpp), so documented not edited. */}
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
