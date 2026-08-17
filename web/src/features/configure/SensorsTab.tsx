import { useState } from "react";
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
import { useEffect } from "react";
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
import { reconcileRulesForRemovedSensor } from "./profileRules";

interface PairFormState {
  rfId: string;
  name: string;
}

// Timing summary for an rfId seen in RTDB events (used for unknown sensors).
interface EventTiming {
  firstSeen: number; // epoch ms
  lastSeen: number; // epoch ms
  count: number;
}

export default function SensorsTab() {
  const { project } = useProject();
  const projectId = project?.id ?? "";

  const [sensors, setSensors] = useState<Sensor[]>([]);
  const [eventTiming, setEventTiming] = useState<Record<string, EventTiming>>(
    {}
  );
  const [pairForm, setPairForm] = useState<PairFormState | null>(null);
  const [pairName, setPairName] = useState("");
  const [loading, setLoading] = useState(true);

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

  // Subscribe to RTDB events. For each rfId, derive first/last seen + count
  // from the timestamp-keyed children so unknown sensors can be told apart and
  // a live trigger shows an updated "last seen".
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

  const handlePair = async () => {
    if (!pairForm || !pairName.trim() || !projectId) return;
    const newSensor: Omit<Sensor, "id"> = {
      rfId: pairForm.rfId,
      name: pairName.trim(),
      pairedAt: Timestamp.now(),
      batteryStatus: "ok",
      lastSeen: null,
    };
    await addDoc(sensorsCol(projectId), newSensor as Sensor);
    // Refresh sensors list
    const snap = await getDocs(sensorsCol(projectId));
    setSensors(snap.docs.map((d) => d.data()));
    setPairForm(null);
    setPairName("");
  };

  // Unpair: strip the sensor from every profile's rules (deleting rules left
  // with no sensors), then remove the sensor definition. Timeline history is
  // kept. The sensor keeps transmitting, so it reappears as unrecognised.
  const handleUnpair = async (sensor: Sensor) => {
    if (!projectId) return;

    // Gather affected rules across all profiles first, so the confirmation can
    // state the real impact.
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
            <th></th>
          </tr>
        </thead>
        <tbody>
          {sensors.map((s) => (
            <tr key={s.id}>
              <td>{s.name}</td>
              <td>{s.rfId}</td>
              <td>{s.batteryStatus}</td>
              <td>{s.pairedAt ? s.pairedAt.toDate().toLocaleString() : "—"}</td>
              <td>
                {s.lastSeen ? s.lastSeen.toDate().toLocaleString() : "Never"}
              </td>
              <td>
                <button type="button" onClick={() => void handleUnpair(s)}>
                  Unpair
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {unknownRfIds.length > 0 && (
        <div>
          <h3>Unrecognised Sensors</h3>
          <p style={{ opacity: 0.7, fontSize: 13 }}>
            Trigger a physical sensor and watch its “Last Seen” update to
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
              {unknownRfIds.map((rfId) => {
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
