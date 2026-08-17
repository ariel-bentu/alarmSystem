// Explore page: unified event timeline with time range selector.
import { useEffect, useState } from "react";
import {
  onSnapshot,
  query,
  where,
  orderBy,
  limit,
  Timestamp,
} from "firebase/firestore";
import { useProject } from "@/app/ProjectProvider";
import { eventsCol } from "@/lib/firestore";
import { rangeCutoff } from "./timeRange";
import type { AlarmEvent, TimeRange } from "@/types";

const TIME_RANGES: TimeRange[] = ["day", "week", "month", "3months", "year"];
const MAX_EVENTS = 500;

export default function ExplorePage() {
  const { project } = useProject();
  const projectId = project?.id;

  const [range, setRange] = useState<TimeRange>("day");
  const [events, setEvents] = useState<AlarmEvent[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!projectId) {
      setEvents([]);
      setLoading(false);
      return;
    }

    setLoading(true);
    const cutoff = Timestamp.fromMillis(rangeCutoff(range, Date.now()));

    const q = query(
      eventsCol(projectId),
      where("timestamp", ">=", cutoff),
      orderBy("timestamp", "desc"),
      limit(MAX_EVENTS)
    );

    const unsub = onSnapshot(q, (snap) => {
      setEvents(snap.docs.map((d) => d.data()));
      setLoading(false);
    });

    return unsub;
  }, [projectId, range]);

  if (!project) {
    return <p>No project selected.</p>;
  }

  return (
    <div>
      <h1>Explore</h1>

      {/* Time range selector */}
      <nav>
        {TIME_RANGES.map((r) => (
          <button
            key={r}
            onClick={() => setRange(r)}
            disabled={r === range}
            aria-pressed={r === range}
          >
            {r}
          </button>
        ))}
      </nav>

      {/* Event feed */}
      {loading ? (
        <p>Loading events...</p>
      ) : events.length === 0 ? (
        <p>No events in this time range.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Timestamp</th>
              <th>Sensor</th>
              <th>Event</th>
              <th>Battery Low</th>
              <th>RSSI</th>
            </tr>
          </thead>
          <tbody>
            {events.map((ev) => (
              <tr key={ev.id}>
                <td>{ev.timestamp.toDate().toLocaleString()}</td>
                <td>{ev.sensorName}</td>
                <td>{ev.eventType}</td>
                <td>{ev.batteryLow ? "Yes" : "No"}</td>
                <td>{ev.rssi}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
