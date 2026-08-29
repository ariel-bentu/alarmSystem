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

  // Dev-only tool (gated behind DEV_SIMULATOR), so its strings stay English —
  // it is never shown to an end user.
  return (
    <div>
      <h1 className="sr-only">Device Simulator</h1>
      <p className="muted">Inject raw events as if the firmware sent them.</p>

      <section className="card">
        <h2 className="card__title">Sensor</h2>
        <label className="check">
          <input
            type="radio"
            checked={!useCustom}
            onChange={() => setUseCustom(false)}
          />
          <span>Paired sensor</span>
        </label>
        {!useCustom && (
          <select
            className="input"
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
        <label className="check">
          <input
            type="radio"
            checked={useCustom}
            onChange={() => setUseCustom(true)}
          />
          <span>Custom rfId</span>
        </label>
        {useCustom && (
          <input
            className="input ltr"
            type="text"
            placeholder="e.g. 0xDEADBE"
            value={customRfId}
            onChange={(e) => setCustomRfId(e.target.value)}
          />
        )}
      </section>

      <section className="card">
        <h2 className="card__title">Event Type</h2>
        {EVENT_TYPES.map((et) => (
          <label key={et} className="check">
            <input
              type="radio"
              name="eventType"
              value={et}
              checked={eventType === et}
              onChange={() => setEventType(et)}
            />
            <span>{et}</span>
          </label>
        ))}
      </section>

      <section className="card">
        <h2 className="card__title">Flags</h2>
        <label className="check">
          <input
            type="checkbox"
            checked={batteryLow}
            onChange={(e) => setBatteryLow(e.target.checked)}
          />
          <span>battery_low</span>
        </label>
        <div className="field">
          <label className="field__label" htmlFor="sim-rssi">
            RSSI
          </label>
          <input
            id="sim-rssi"
            className="input input--narrow"
            type="number"
            value={rssi}
            onChange={(e) => setRssi(Number(e.target.value))}
          />
        </div>
      </section>

      <button className="btn btn--primary" onClick={handleFire}>
        Fire Event
      </button>

      {status && <p role="status">{status}</p>}
    </div>
  );
}
