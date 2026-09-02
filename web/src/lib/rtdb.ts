// Typed Realtime Database path helpers. All device-facing paths are namespaced
// under projectId. Feature tracks (operations, simulator) import these.
import { ref, DatabaseReference } from "firebase/database";
import { rtdb } from "./firebase";

export const statePath = (projectId: string) => `${projectId}/state`;
export const stateArmedPath = (projectId: string) => `${projectId}/state/armed`;
export const stateSirenPath = (projectId: string) =>
  `${projectId}/state/siren_active`;
export const commandsArmedPath = (projectId: string) =>
  `${projectId}/commands/armed`;
export const commandsSirenPath = (projectId: string) =>
  `${projectId}/commands/siren`;
export const configPath = (projectId: string) => `${projectId}/config`;
export const eventPath = (
  projectId: string,
  sensorRfId: string,
  timestamp: number
) => `${projectId}/events/${sensorRfId}/${timestamp}`;

export const stateRef = (projectId: string): DatabaseReference =>
  ref(rtdb, statePath(projectId));
export const stateArmedRef = (projectId: string): DatabaseReference =>
  ref(rtdb, stateArmedPath(projectId));
export const stateSirenRef = (projectId: string): DatabaseReference =>
  ref(rtdb, stateSirenPath(projectId));
export const commandsArmedRef = (projectId: string): DatabaseReference =>
  ref(rtdb, commandsArmedPath(projectId));
export const commandsSirenRef = (projectId: string): DatabaseReference =>
  ref(rtdb, commandsSirenPath(projectId));
export const configRef = (projectId: string): DatabaseReference =>
  ref(rtdb, configPath(projectId));
export const eventRef = (
  projectId: string,
  sensorRfId: string,
  timestamp: number
): DatabaseReference => ref(rtdb, eventPath(projectId, sensorRfId, timestamp));

export const stateLastSeenPath = (projectId: string) =>
  `${projectId}/state/last_seen`;
export const stateLastSeenRef = (projectId: string): DatabaseReference =>
  ref(rtdb, stateLastSeenPath(projectId));

// Why the device last booted: { reason, at }. Written once per boot by the
// firmware (CloudClient::reportBoot). `reason` is "power_on" for an ordinary
// unplug, but "panic" / "twdt" / "brownout" mean the device died on its own
// and came back — which is otherwise invisible, since a rebooted device
// looks identical to one that never left.
export const stateBootPath = (projectId: string) => `${projectId}/state/boot`;
export const stateBootRef = (projectId: string): DatabaseReference =>
  ref(rtdb, stateBootPath(projectId));

// What tripped the alarm. Written by the device ({rfId, ct, at}) and by the
// server ({label, at}) — see features/operations/alarmState.ts.
export const stateAlarmCausePath = (projectId: string) =>
  `${projectId}/state/alarm_cause`;
export const stateAlarmCauseRef = (projectId: string): DatabaseReference =>
  ref(rtdb, stateAlarmCausePath(projectId));

export const commandsPairPath = (projectId: string) =>
  `${projectId}/commands/pair`;
export const stateSirenBasePath = (projectId: string) =>
  `${projectId}/state/siren_base`;

export const commandsPairRef = (projectId: string): DatabaseReference =>
  ref(rtdb, commandsPairPath(projectId));
export const stateSirenBaseRef = (projectId: string): DatabaseReference =>
  ref(rtdb, stateSirenBasePath(projectId));
