// Operations dashboard page. Arm the device or server by selecting an enabled
// profile (Kerui-style button grid), or Disarm. Shows siren + per-sensor info.
import { useEffect, useState } from "react";
import { onSnapshot, updateDoc, writeBatch } from "firebase/firestore";
import { set } from "firebase/database";
import { db } from "@/lib/firebase";
import { useProject } from "@/app/ProjectProvider";
import { sensorsCol, profilesCol, projectDoc, profileDoc } from "@/lib/firestore";
import { commandsArmedRef, commandsSirenRef } from "@/lib/rtdb";
import { useDeviceState } from "./useDeviceState";
import type { Sensor, Profile } from "@/types";

type Side = "device" | "server";

export default function OperationsPage() {
  const { project, role } = useProject();
  const projectId = project?.id;
  const { armed: deviceArmed, sirenActive, loading: rtdbLoading } = useDeviceState(projectId);

  const [sensors, setSensors] = useState<Sensor[]>([]);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [serverArmed, setServerArmed] = useState<boolean>(false);
  const [busy, setBusy] = useState(false);

  // Live Firestore: sensors
  useEffect(() => {
    if (!projectId) return;
    const unsub = onSnapshot(sensorsCol(projectId), (snap) => {
      setSensors(snap.docs.map((d) => d.data()));
    });
    return unsub;
  }, [projectId]);

  // Live Firestore: profiles
  useEffect(() => {
    if (!projectId) return;
    const unsub = onSnapshot(profilesCol(projectId), (snap) => {
      setProfiles(snap.docs.map((d) => d.data()));
    });
    return unsub;
  }, [projectId]);

  // Track serverArmed from project doc
  useEffect(() => {
    if (!project) return;
    setServerArmed(project.serverArmed);
  }, [project]);

  const canArm = role === "user" || role === "admin";
  // Only enabled profiles are available to arm.
  const availableProfiles = profiles.filter((p) => p.enabled !== false);
  const activeDeviceId = profiles.find((p) => p.isActiveOnDevice)?.id ?? null;
  const activeServerId = profiles.find((p) => p.isActiveOnServer)?.id ?? null;

  // Arm a side to a specific profile (or disarm when profileId is null).
  const armSide = async (side: Side, profileId: string | null) => {
    if (!projectId || !canArm || busy) return;
    setBusy(true);
    try {
      const field = side === "device" ? "isActiveOnDevice" : "isActiveOnServer";
      const batch = writeBatch(db);
      for (const p of profiles) {
        const shouldBeActive = p.id === profileId;
        if (Boolean(p[field]) !== shouldBeActive) {
          batch.update(profileDoc(projectId, p.id), { [field]: shouldBeActive });
        }
      }
      await batch.commit();

      // Reflect arm state on the side's boolean channel.
      if (side === "device") {
        await set(commandsArmedRef(projectId), profileId !== null);
      } else {
        await updateDoc(projectDoc(projectId), {
          serverArmed: profileId !== null,
        });
        setServerArmed(profileId !== null);
      }
    } finally {
      setBusy(false);
    }
  };

  const handleSilenceSiren = async () => {
    if (!projectId || role !== "admin") return;
    await set(commandsSirenRef(projectId), false);
  };

  if (!project) {
    return <p>No project selected.</p>;
  }

  // Button grid for one side: Disarmed + one button per enabled profile.
  const ArmGrid = ({ side, activeId }: { side: Side; activeId: string | null }) => (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
      <button
        onClick={() => void armSide(side, null)}
        disabled={!canArm || busy}
        style={armBtnStyle(activeId === null)}
      >
        🔓 Disarmed
      </button>
      {availableProfiles.map((p) => (
        <button
          key={p.id}
          onClick={() => void armSide(side, p.id)}
          disabled={!canArm || busy}
          style={armBtnStyle(activeId === p.id)}
        >
          🛡 {p.displayName}
        </button>
      ))}
    </div>
  );

  return (
    <div>
      <h1>Operations</h1>

      {rtdbLoading ? (
        <p>Loading device state…</p>
      ) : (
        <>
          <section>
            <h2>Device {deviceArmed ? "— ARMED" : "— Disarmed"}</h2>
            <ArmGrid side="device" activeId={activeDeviceId} />
          </section>

          <section>
            <h2>Server {serverArmed ? "— ARMED" : "— Disarmed"}</h2>
            <ArmGrid side="server" activeId={activeServerId} />
          </section>

          <section>
            <h2>Siren</h2>
            <p>
              {sirenActive ? "🚨 ACTIVE" : "Inactive"}{" "}
              {role === "admin" && sirenActive && (
                <button onClick={handleSilenceSiren}>Force Silence</button>
              )}
            </p>
          </section>
        </>
      )}

      {/* Sensors */}
      <section>
        <h2>Sensors</h2>
        {sensors.length === 0 ? (
          <p>No sensors paired.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>RF ID</th>
                <th>Last Seen</th>
                <th>Battery</th>
              </tr>
            </thead>
            <tbody>
              {sensors.map((s) => (
                <tr key={s.id}>
                  <td>{s.name}</td>
                  <td>{s.rfId}</td>
                  <td>
                    {s.lastSeen
                      ? s.lastSeen.toDate().toLocaleString()
                      : "Never"}
                  </td>
                  <td>{s.batteryStatus}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}

function armBtnStyle(active: boolean): React.CSSProperties {
  return {
    padding: "12px 20px",
    borderRadius: 8,
    border: active ? "2px solid #2e7d32" : "1px solid #bbb",
    background: active ? "#2e7d32" : "transparent",
    color: active ? "#fff" : "inherit",
    fontWeight: active ? 700 : 400,
    cursor: "pointer",
    minWidth: 110,
  };
}
