// Device Simulator page (dev only). Writes raw events to RTDB.
import { useState, useEffect } from "react";
import { onSnapshot } from "firebase/firestore";
import { set } from "firebase/database";
import { useProject } from "@/app/ProjectProvider";
import { sensorsCol } from "@/lib/firestore";
import { eventRef } from "@/lib/rtdb";
import { buildRawEvent } from "./rawEvent";
import type { Sensor } from "@/types";

type SimEventType = "trigger" | "tamper" | "battery_low";
const EVENT_TYPES: SimEventType[] = ["trigger", "tamper", "battery_low"];

export default function SimulatorPage() {
  const { project } = useProject();
  const projectId = project?.id;

  const [sensors, setSensors] = useState<Sensor[]>([]);
  const [selectedSensorId, setSelectedSensorId] = useState<string>("");
  const [customRfId, setCustomRfId] = useState<string>("");
  const [useCustom, setUseCustom] = useState(false);
  const [eventType, setEventType] = useState<SimEventType>("trigger");
  const [batteryLow, setBatteryLow] = useState(false);
  const [rssi, setRssi] = useState(-65);
  const [status, setStatus] = useState<string>("");

  // Load sensors for the dropdown
  useEffect(() => {
    if (!projectId) return;
    const unsub = onSnapshot(sensorsCol(projectId), (snap) => {
      const list = snap.docs.map((d) => d.data());
      setSensors(list);
      if (list.length > 0 && !selectedSensorId) {
        setSelectedSensorId(list[0].rfId);
      }
    });
    return unsub;
  }, [projectId]);

  const resolveRfId = (): string => {
    if (useCustom) return customRfId.trim();
    return selectedSensorId;
  };

  const handleFire = async () => {
    if (!projectId) return;
    const rfId = resolveRfId();
    if (!rfId) {
      setStatus("Error: No rfId specified.");
      return;
    }

    const payload = buildRawEvent(eventType, batteryLow, rssi);
    const timestamp = Date.now();

    try {
      await set(eventRef(projectId, rfId, timestamp), payload);
      setStatus(`Sent ${eventType} for ${rfId} at ${timestamp}`);
    } catch (err) {
      setStatus(`Error: ${(err as Error).message}`);
    }
  };

  if (!project) {
    return <p>No project selected.</p>;
  }

  return (
    <div>
      <h1>Device Simulator</h1>
      <p>Inject raw events as if the firmware sent them.</p>

      {/* Sensor selection */}
      <fieldset>
        <legend>Sensor</legend>
        <label>
          <input
            type="radio"
            checked={!useCustom}
            onChange={() => setUseCustom(false)}
          />
          Paired sensor
        </label>
        {!useCustom && (
          <select
            value={selectedSensorId}
            onChange={(e) => setSelectedSensorId(e.target.value)}
          >
            {sensors.map((s) => (
              <option key={s.id} value={s.rfId}>
                {s.name} ({s.rfId})
              </option>
            ))}
            {sensors.length === 0 && <option value="">No sensors</option>}
          </select>
        )}
        <br />
        <label>
          <input
            type="radio"
            checked={useCustom}
            onChange={() => setUseCustom(true)}
          />
          Custom rfId
        </label>
        {useCustom && (
          <input
            type="text"
            placeholder="e.g. 0xDEADBE"
            value={customRfId}
            onChange={(e) => setCustomRfId(e.target.value)}
          />
        )}
      </fieldset>

      {/* Event type */}
      <fieldset>
        <legend>Event Type</legend>
        {EVENT_TYPES.map((et) => (
          <label key={et}>
            <input
              type="radio"
              name="eventType"
              value={et}
              checked={eventType === et}
              onChange={() => setEventType(et)}
            />
            {et}
          </label>
        ))}
      </fieldset>

      {/* Flags */}
      <fieldset>
        <legend>Flags</legend>
        <label>
          <input
            type="checkbox"
            checked={batteryLow}
            onChange={(e) => setBatteryLow(e.target.checked)}
          />
          battery_low
        </label>
        <br />
        <label>
          RSSI:{" "}
          <input
            type="number"
            value={rssi}
            onChange={(e) => setRssi(Number(e.target.value))}
            style={{ width: "80px" }}
          />
        </label>
      </fieldset>

      {/* Fire */}
      <button onClick={handleFire}>Fire Event</button>

      {/* Status */}
      {status && <p>{status}</p>}
    </div>
  );
}
