import { useState, useEffect } from "react";
import {
  ref,
  onValue,
  DataSnapshot,
} from "firebase/database";
import {
  getDocs,
  addDoc,
  deleteDoc,
  updateDoc,
  Timestamp,
} from "firebase/firestore";
import { rtdb } from "@/lib/firebase";
import {
  sensorsCol,
  sensorDoc,
  profilesCol,
  rulesCol,
  ruleDoc,
} from "@/lib/firestore";
import { useProject } from "@/app/ProjectProvider";
import type { Sensor } from "@/types";
import { getUnknownRfIds } from "./unknownSensors";
import {
  effectiveLastSeen,
  isJustSeen,
  sortByLastSeenDesc,
  type EventTiming,
} from "./sensorRecency";
import { reconcileRulesForRemovedSensor } from "./profileRules";

interface PairFormState {
  rfId: string;
  name: string;
}

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

// Green dot marking a sensor heard from within the last minute.
function JustSeenDot() {
  return (
    <span
      style={{
        display: "inline-block",
        width: 8,
        height: 8,
        borderRadius: "50%",
        background: "#22c55e",
        marginRight: 6,
        verticalAlign: "middle",
      }}
    />
  );
}

export default function SensorsTab() {
  const { project } = useProject();
  const projectId = project?.id ?? "";

  const [sensors, setSensors] = useState<Sensor[]>([]);
  const [eventTiming, setEventTiming] = useState<Record<string, EventTiming>>({});
  const [pairForm, setPairForm] = useState<PairFormState | null>(null);
  const [pairName, setPairName] = useState("");
  const [loading, setLoading] = useState(true);
  const [now, setNow] = useState(() => Date.now());
  const [olderExpanded, setOlderExpanded] = useState(false);

  // Keep `now` fresh so recency highlights update without a page reload.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 10_000);
    return () => clearInterval(id);
  }, []);

  // Load paired sensors from Firestore
  useEffect(() => {
    if (!projectId) return;
    let cancelled = false;
    async function load() {
      const snap = await getDocs(sensorsCol(projectId));
      if (!cancelled) {
        setSensors(snap.docs.map((d) => d.data()));
        setLoading(false);
      }
    }
    void load();
    return () => { cancelled = true; };
  }, [projectId]);

  // Subscribe to RTDB events. For each rfId, derive first/last seen + count.
  useEffect(() => {
    if (!projectId) return;
    const eventsRef = ref(rtdb, `${projectId}/events`);
    const unsub = onValue(eventsRef, (snapshot: DataSnapshot) => {
      const val = snapshot.val();
      const timing: Record<string, EventTiming> = {};
      if (val && typeof val === "object") {
        for (const [rfId, events] of Object.entries(
          val as Record<string, Record<string, unknown>>
        )) {
          const tsKeys = Object.keys(events ?? {}).map(Number).filter((n) => !Number.isNaN(n));
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

  const eventRfIds = Object.keys(eventTiming);
  const knownRfIds = sensors.map((s) => s.rfId);
  const unknownRfIds = getUnknownRfIds(eventRfIds, knownRfIds);

  // Paired sensors: last seen is the newer of the live RTDB event and the
  // Firestore field, so the table updates as events arrive.
  const pairedLastSeen = (s: Sensor) =>
    effectiveLastSeen(s.rfId, eventTiming, s.lastSeen?.toMillis() ?? null);
  const sortedSensors = sortByLastSeenDesc(sensors, pairedLastSeen);

  // Sort unknown sensors by last seen descending (most recent first).
  const sortedUnknownRfIds = sortByLastSeenDesc(
    unknownRfIds,
    (rfId) => eventTiming[rfId]?.lastSeen ?? null
  );

  const recentUnknown = sortedUnknownRfIds.filter(
    (id) => now - (eventTiming[id]?.lastSeen ?? 0) <= ONE_DAY_MS
  );
  const olderUnknown = sortedUnknownRfIds.filter(
    (id) => now - (eventTiming[id]?.lastSeen ?? 0) > ONE_DAY_MS
  );

  const handlePair = async () => {
    if (!pairForm || !pairName.trim() || !projectId) return;
    const newSensor: Omit<Sensor, "id"> = {
      rfId: pairForm.rfId,
      name: pairName.trim(),
      pairedAt: Timestamp.now(),
      batteryStatus: "ok",
      lastSeen: null,
      deadSensorAlertDays: -1,
      deadAlertSentAt: null,
    };
    await addDoc(sensorsCol(projectId), newSensor as Sensor);
    const snap = await getDocs(sensorsCol(projectId));
    setSensors(snap.docs.map((d) => d.data()));
    setPairForm(null);
    setPairName("");
  };

  const handleUnpair = async (sensor: Sensor) => {
    if (!projectId) return;

    const profilesSnap = await getDocs(profilesCol(projectId));
    const plans: {
      profileId: string;
      recon: ReturnType<typeof reconcileRulesForRemovedSensor>;
    }[] = [];
    for (const p of profilesSnap.docs) {
      const rulesSnap = await getDocs(rulesCol(projectId, p.id));
      const rules = rulesSnap.docs.map((d) => d.data());
      const recon = reconcileRulesForRemovedSensor(rules, sensor.id);
      if (recon.toDelete.length || recon.toUpdate.length) {
        plans.push({ profileId: p.id, recon });
      }
    }

    const deletes = plans.reduce((n, p) => n + p.recon.toDelete.length, 0);
    const updates = plans.reduce((n, p) => n + p.recon.toUpdate.length, 0);
    const impact =
      deletes || updates
        ? `\n\n${updates} rule(s) will be updated and ${deletes} rule(s) deleted.`
        : "";
    if (
      !window.confirm(
        `Unpair "${sensor.name}" (${sensor.rfId})?${impact}\n\nPast events stay in the timeline. The sensor will reappear as unrecognised if it keeps transmitting.`
      )
    ) {
      return;
    }

    for (const plan of plans) {
      for (const r of plan.recon.toDelete) {
        await deleteDoc(ruleDoc(projectId, plan.profileId, r.id));
      }
      for (const r of plan.recon.toUpdate) {
        await updateDoc(ruleDoc(projectId, plan.profileId, r.id), {
          sensors: r.sensors,
          condition: r.condition,
        });
      }
    }

    await deleteDoc(sensorDoc(projectId, sensor.id));
    const snap = await getDocs(sensorsCol(projectId));
    setSensors(snap.docs.map((d) => d.data()));
  };

  const handleDeadAlertDaysChange = async (sensor: Sensor, days: number) => {
    if (!projectId) return;
    await updateDoc(sensorDoc(projectId, sensor.id), { deadSensorAlertDays: days });
    setSensors((prev) =>
      prev.map((s) => s.id === sensor.id ? { ...s, deadSensorAlertDays: days } : s)
    );
  };

  if (loading) return <p>Loading sensors...</p>;

  return (
    <div>
      <h2>Paired Sensors</h2>
      {sensors.length === 0 && <p>No paired sensors yet.</p>}
      <table>
        <thead>
          <tr>
            <th>Name</th>
            <th>RF ID</th>
            <th>Battery</th>
            <th>Paired</th>
            <th>Last Seen</th>
            <th title="Days without a trigger before sending a Telegram alert. -1 = never.">Alert after (days)</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {sortedSensors.map((s) => {
            const lastSeen = pairedLastSeen(s);
            const justSeen = isJustSeen(lastSeen, now);
            return (
            <tr key={s.id} style={justSeen ? { fontWeight: "bold" } : undefined}>
              <td>
                {justSeen && <JustSeenDot />}
                {s.name}
              </td>
              <td>{s.rfId}</td>
              <td>{s.batteryStatus}</td>
              <td>{s.pairedAt ? s.pairedAt.toDate().toLocaleString() : "—"}</td>
              <td>
                {lastSeen !== null
                  ? new Date(lastSeen).toLocaleString()
                  : "Never"}
              </td>
              <td>
                <input
                  type="number"
                  min={-1}
                  style={{ width: 60 }}
                  value={s.deadSensorAlertDays ?? -1}
                  onChange={(e) => {
                    const v = parseInt(e.target.value, 10);
                    if (!Number.isNaN(v)) void handleDeadAlertDaysChange(s, v);
                  }}
                  title="-1 = never alert"
                />
              </td>
              <td>
                <button type="button" onClick={() => void handleUnpair(s)}>
                  Unpair
                </button>
              </td>
            </tr>
            );
          })}
        </tbody>
      </table>

      {unknownRfIds.length === 0 && (
        <div style={{ opacity: 0.7, fontSize: 13, marginTop: 16 }}>
          <h3 style={{ marginBottom: 4 }}>Unrecognised Sensors</h3>
          <p style={{ margin: 0 }}>
            None seen. Unpaired sensors appear here as soon as they transmit &mdash;
            they are read live from this project&rsquo;s RTDB events, not from
            Firestore, so nothing needs to be set up first.
          </p>
          <p style={{ margin: "6px 0 0" }}>
            If a sensor <em>is</em> transmitting, check that the project shown
            in the header (<code>{projectId || "none"}</code>) is the one your
            device reports to &mdash; each project reads a separate{" "}
            <code>/&lt;projectId&gt;/events</code> path.
          </p>
        </div>
      )}

      {unknownRfIds.length > 0 && (
        <div>
          <h3>Unrecognised Sensors</h3>
          <p style={{ opacity: 0.7, fontSize: 13 }}>
            Trigger a physical sensor and watch its &quot;Last Seen&quot; update to
            identify it.
          </p>
          <table>
            <thead>
              <tr>
                <th>RF ID</th>
                <th>First Seen</th>
                <th>Last Seen</th>
                <th>Events</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {recentUnknown.map((rfId) => {
                const t = eventTiming[rfId];
                const justSeen = isJustSeen(t?.lastSeen ?? null, now);
                return (
                  <tr key={rfId} style={justSeen ? { fontWeight: "bold" } : undefined}>
                    <td>
                      {justSeen && <JustSeenDot />}
                      {rfId}
                    </td>
                    <td>{t ? new Date(t.firstSeen).toLocaleString() : "—"}</td>
                    <td>{t ? new Date(t.lastSeen).toLocaleString() : "—"}</td>
                    <td>{t?.count ?? 0}</td>
                    <td>
                      <button
                        onClick={() => {
                          setPairForm({ rfId, name: "" });
                          setPairName("");
                        }}
                      >
                        Pair
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>

          {olderUnknown.length > 0 && (
            <div style={{ marginTop: 8 }}>
              <button
                type="button"
                style={{ background: "none", border: "none", cursor: "pointer", padding: 0, opacity: 0.7, fontSize: 13 }}
                onClick={() => setOlderExpanded((v) => !v)}
              >
                {olderExpanded ? "▾" : "▸"} Older sensors ({olderUnknown.length})
              </button>
              {olderExpanded && (
                <table style={{ marginTop: 4 }}>
                  <thead>
                    <tr>
                      <th>RF ID</th>
                      <th>First Seen</th>
                      <th>Last Seen</th>
                      <th>Events</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {olderUnknown.map((rfId) => {
                      const t = eventTiming[rfId];
                      return (
                        <tr key={rfId}>
                          <td>{rfId}</td>
                          <td>{t ? new Date(t.firstSeen).toLocaleString() : "—"}</td>
                          <td>{t ? new Date(t.lastSeen).toLocaleString() : "—"}</td>
                          <td>{t?.count ?? 0}</td>
                          <td>
                            <button
                              onClick={() => {
                                setPairForm({ rfId, name: "" });
                                setPairName("");
                              }}
                            >
                              Pair
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </div>
          )}
        </div>
      )}

      {pairForm && (
        <div>
          <h3>Pair Sensor: {pairForm.rfId}</h3>
          <label>
            Name:{" "}
            <input
              type="text"
              value={pairName}
              onChange={(e) => setPairName(e.target.value)}
              placeholder="e.g. Front door"
            />
          </label>
          <button onClick={handlePair} disabled={!pairName.trim()}>
            Save
          </button>
          <button onClick={() => setPairForm(null)}>Cancel</button>
        </div>
      )}
    </div>
  );
}
