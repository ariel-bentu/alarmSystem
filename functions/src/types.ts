// Domain types for Cloud Functions. Mirror of web/src/types — keep in sync.
import { Timestamp } from "firebase-admin/firestore";

export type Role = "admin" | "user";
export type BatteryStatus = "ok" | "low";
export type ConditionType =
  | "immediate"
  | "count_in_window"
  | "entry_delay"
  | "multi_sensor";
export type EventType =
  | "trigger"
  | "tamper"
  | "battery_low"
  | "alarm"
  | "armed"
  | "disarmed";

export interface Condition {
  type: ConditionType;
  count?: number;
  window_sec?: number;
  delay_sec?: number;
  // multi_sensor only: per-sensor trigger counts required inside window_sec.
  // Missing entries default to 1. All sensors of the rule must be satisfied (AND).
  counts?: Record<string, number>;
}

export interface Rule {
  id: string;
  name: string;
  sensors: string[];
  condition: Condition;
}

export interface Sensor {
  id: string;
  rfId: string;
  name: string;
  pairedAt: Timestamp;
  batteryStatus: BatteryStatus;
  lastSeen: Timestamp | null;
}

export interface Profile {
  id: string;
  displayName: string;
  createdAt: Timestamp;
  enabled: boolean;
  isActiveOnDevice: boolean;
  isActiveOnServer: boolean;
}

export interface TenantMembership {
  name: string;
  role: Role;
}

export interface Member {
  id: string; // doc id = lowercased email
  role: Role;
  email: string;
  invitedBy: string; // inviter email
  joinedAt: Timestamp;
}

export interface UserDoc {
  id: string; // = lowercased email
  email: string;
  displayName: string;
  photoURL: string;
  isSystemAdmin: boolean;
  tenants: Record<string, TenantMembership>;
}

export interface ServerActions {
  sendTelegram: boolean;
  triggerSiren: boolean;
}

export interface DeviceInfo {
  name: string;
  apiKeyHash: string;
  lastSeen: Timestamp | null;
}

export interface Project {
  id: string;
  name: string;
  createdAt: Timestamp;
  ownerId: string;
  telegramBotToken: string;
  telegramChatId: string;
  serverArmed: boolean;
  serverActions: ServerActions;
  sirenDurationSec: number;
  notifyEverySensorTrigger?: boolean;
  device: DeviceInfo;
}

export interface Invite {
  id: string;
  email: string;
  role: Role;
  createdBy: string;
  createdAt: Timestamp;
  expiresAt: Timestamp;
  acceptedAt: Timestamp | null;
  acceptedBy: string | null;
}

export interface RtdbRawEvent {
  event: string;
  battery_low: boolean;
  rssi: number;
}

// Condition as written into the RTDB config. Identical to the Firestore
// Condition except that multi_sensor `counts` are keyed by **rfId**, because the
// device only knows rfIds — it never sees Firestore document ids.
export interface RtdbCondition extends Omit<Condition, "counts"> {
  counts?: Record<string, number>; // keyed by rfId
}

export interface RtdbConfigSensor {
  name: string;
  enabled: boolean;
  conditions: RtdbCondition[];
}

export interface RtdbConfig {
  armed: boolean;
  siren_duration_sec: number;
  sensors: Record<string, RtdbConfigSensor>;
}

export interface AlarmEvent {
  id: string;
  sensorId: string;
  rfId: string;
  sensorName: string;
  eventType: EventType;
  batteryLow: boolean;
  rssi: number;
  timestamp: Timestamp;
}
