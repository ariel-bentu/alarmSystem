// Telegram helper: send messages and pure formatting functions.

import { BatteryStatus } from "./types";
import { Timestamp } from "firebase-admin/firestore";

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
    default:
      return `📡 ${sensorName}: ${eventType}`;
  }
}

// label = the rule/condition name, or the sensor name when the rule is unnamed.
export function formatAlarm(label: string): string {
  return `🚨 Alarm triggered — ${label}`;
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

export function formatDeadSensor(sensorName: string, hoursSilent: number): string {
  return `💤 ${sensorName} has not reported in ${hoursSilent}h`;
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
