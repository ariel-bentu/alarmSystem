// Telegram helper: send messages and pure formatting functions.

import { BatteryStatus, ArmSource } from "./types";
import { Timestamp } from "firebase-admin/firestore";
import { parseArmSource } from "./deviceArmNotify";

/**
 * Send a message via Telegram Bot API using global fetch (Node 20).
 *
 * `silent` sets disable_notification: the message lands in the chat with no
 * sound or vibration. Used for notices (arm/disarm, command replies); alarms
 * and dead-sensor alerts stay loud so the loud channel keeps its meaning.
 */
export async function sendTelegram(
  botToken: string,
  chatId: string,
  text: string,
  silent = false
): Promise<void> {
  const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
  const payload: Record<string, unknown> = {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
  };
  if (silent) payload.disable_notification = true;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const body = await res.text();
    console.error(`Telegram API error: ${res.status} ${body}`);
  }
}

// --- Pure formatters (unit-tested) ---

export function formatSensorAlert(sensorName: string, eventType: string): string {
  switch (eventType) {
    case "trigger":
      return `📡 ${sensorName} triggered`;
    case "tamper":
      return `⚠️ ${sensorName} tampered`;
    case "battery_low":
      return `🔋 ${sensorName} battery low`;
    case "water":
      return formatWater(sensorName);
    default:
      return `📡 ${sensorName}: ${eventType}`;
  }
}

// A water sensor reporting a leak (Kerui nibble 0x5). Sent ONCE per
// condition — the marker on the sensor doc is what stops a leaking sensor
// Telegramming on every packet. Never sirens: a leak is urgent but is not
// an intrusion, and waking the street does not stop water.
//
// No `close` formatter exists on purpose: close events are recorded in the
// timeline and notify nothing at all.
export function formatWater(sensorName: string): string {
  return `💧 ${sensorName} detected water`;
}

// label = the rule/condition name, or the sensor name when the rule is unnamed.
export function formatAlarm(label: string): string {
  return `🚨 Alarm triggered — ${label}`;
}

// Human name for a cloud arm source, used as the `side` of formatArmState.
// A scheduled arm previously said "Device armed" — technically the side that
// armed, but it reads as though the hardware did it on its own, which is the
// same conflation the timeline had. Only the cloud sources appear here; the
// device-originated ones go through formatArmStateBySource instead.
export function armSourceLabel(source: ArmSource): string {
  if (source === "schedule") return "Schedule";
  if (source === "telegram") return "Telegram";
  return "App";
}

// side: "Device" | "Server" (omitted for a generic system-wide message).
// profileName: the profile armed to, when known.
export function formatArmState(
  armed: boolean,
  side?: string,
  profileName?: string
): string {
  const what = side ? `${side}` : "System";
  if (!armed) return `🔓 ${what} disarmed`;
  return profileName
    ? `🔒 ${what} armed — ${profileName}`
    : `🔒 ${what} armed`;
}

// Names WHO armed/disarmed when the change originated on the device rather
// than in the web app. "Who disarmed my house" is the security-relevant
// question a fixed-code remote cannot answer any other way — a replayed
// disarm cannot be prevented, so it must at least be attributed.
//
// `remoteName` is the paired remote's user-given name when the identity in
// state/armed_by resolved to one. Passed in rather than looked up here so
// this stays a pure formatter, and so the Telegram message and the timeline
// row cannot disagree about which remote it was.
//
// NOTE: matches on the PARSED source kind, not on `source === "remote"`.
// The device now sends "remote:E45CA", which an equality check would miss —
// silently downgrading every remote arm/disarm to the generic "Device
// armed", i.e. losing exactly the attribution this function exists for.
export function formatArmStateBySource(
  armed: boolean,
  source: string | null,
  remoteName?: string | null
): string {
  const icon = armed ? "🔒" : "🔓";
  const verb = armed ? "Armed" : "Disarmed";
  const kind = parseArmSource(source).kind;
  if (kind === "remote") {
    return remoteName
      ? `${icon} ${verb} by ${remoteName}`
      : `${icon} ${verb} by remote`;
  }
  if (kind === "local") return `${icon} ${verb} from local web UI`;
  return `${icon} Device ${verb.toLowerCase()}`;
}

export function formatDeadSensor(sensorName: string, hoursSilent: number): string {
  return `💤 ${sensorName} has not reported in ${hoursSilent}h`;
}

// A battery approaching end of life, not a sensor that has already gone
// quiet — named separately from formatDeadSensor for the same reason
// formatDeviceOffline is: the consequence differs in kind. This one is
// advisory maintenance, so it reads as a suggestion rather than an incident.
export function formatStaleBattery(
  sensorName: string,
  months: number
): string {
  return `🔋 ${sensorName} battery is ${months} months old — consider replacing`;
}

// The CONTROLLER went silent, not a sensor. Named separately from
// formatDeadSensor because the consequence is different in kind: one dead
// sensor is a blind spot, a dead controller while armed means nothing is
// being watched at all. `silence` is pre-humanised (see formatSilence).
export function formatDeviceOffline(silence: string, armed: boolean): string {
  const state = armed ? " while ARMED" : "";
  return `📵 Alarm device offline${state} — no heartbeat for ${silence}`;
}

export function formatDeviceBackOnline(silence: string): string {
  return `✅ Alarm device back online — was offline for ${silence}`;
}

export interface StatusInfo {
  serverArmed: boolean;
  deviceArmed: boolean;
  sirenActive: boolean;
  activeDeviceProfile: string | null;
  activeServerProfile: string | null;
  sensors: Array<{ name: string; lastSeen: Timestamp | null; batteryStatus: BatteryStatus }>;
}

export function formatStatus(info: StatusInfo): string {
  const lines: string[] = [];
  lines.push(`<b>Status</b>`);
  lines.push(`Server armed: ${info.serverArmed ? "YES" : "NO"}`);
  lines.push(`Device armed: ${info.deviceArmed ? "YES" : "NO"}`);
  lines.push(`Siren active: ${info.sirenActive ? "YES" : "NO"}`);
  lines.push(`Device profile: ${info.activeDeviceProfile ?? "none"}`);
  lines.push(`Server profile: ${info.activeServerProfile ?? "none"}`);
  lines.push("");
  lines.push("<b>Sensors</b>");
  for (const s of info.sensors) {
    const seenStr = s.lastSeen
      ? s.lastSeen.toDate().toISOString().replace("T", " ").slice(0, 19)
      : "never";
    const battery = s.batteryStatus === "low" ? " 🔋LOW" : "";
    lines.push(`• ${s.name} — last: ${seenStr}${battery}`);
  }
  return lines.join("\n");
}
