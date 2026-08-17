// Shared domain types. Consumed by every feature track and the Cloud Functions
// (functions re-declare their own copy; keep the two in sync manually).
import { Timestamp } from "firebase/firestore";

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

// ---- Firestore documents ----

export interface ServerActions {
  sendTelegram: boolean;
  triggerSiren: boolean; // whether server writes siren_active to RTDB on alarm
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
  ownerId: string; // lowercased email of the creating admin
  telegramBotToken: string;
  telegramChatId: string;
  serverArmed: boolean;
  serverActions: ServerActions;
  sirenDurationSec: number;
  notifyEverySensorTrigger: boolean; // Telegram on every sensor trigger (battery/tamper always notify)
  device: DeviceInfo;
}

export interface Member {
  id: string; // doc id = lowercased email (human-readable)
  role: Role;
  email: string;
  invitedBy: string; // email of the inviter
  joinedAt: Timestamp;
}

// Per-tenant membership entry inside a UserDoc.tenants map.
export interface TenantMembership {
  name: string; // denormalized project name for the switcher
  role: Role;
}

// Top-level user profile + membership index, keyed by lowercased email.
// ProjectProvider reads this single doc (no index). Written only by the
// provisionUser Cloud Function — clients cannot write /users.
export interface UserDoc {
  id: string; // = lowercased email
  email: string;
  displayName: string;
  photoURL: string;
  isSystemAdmin: boolean;
  tenants: Record<string, TenantMembership>; // projectId -> { name, role }
}

export interface Invite {
  id: string;
  email: string;
  role: Role;
  createdBy: string; // userId
  createdAt: Timestamp;
  expiresAt: Timestamp;
  acceptedAt: Timestamp | null;
  acceptedBy: string | null; // userId
}

export interface Sensor {
  id: string; // sensorId
  rfId: string; // hex e.g. "0xA1B2C3"
  name: string;
  pairedAt: Timestamp;
  batteryStatus: BatteryStatus;
  lastSeen: Timestamp | null;
}

export interface Condition {
  type: ConditionType;
  count?: number; // count_in_window
  window_sec?: number; // count_in_window, multi_sensor
  delay_sec?: number; // entry_delay
  // multi_sensor only: per-sensor trigger counts required inside window_sec.
  // Missing entries default to 1. All sensors of the rule must be satisfied (AND).
  counts?: Record<string, number>;
}

export interface Rule {
  id: string; // ruleId
  name: string; // required when the rule spans several sensors
  sensors: string[]; // sensorIds; a sensor may appear in several rules (rules are OR'd)
  condition: Condition;
}

export interface Profile {
  id: string; // profileId = lowercased name, e.g. "away"
  displayName: string;
  createdAt: Timestamp;
  enabled: boolean; // available to arm in Operations; disabled profiles are hidden
  isActiveOnDevice: boolean;
  isActiveOnServer: boolean;
}

export interface AlarmEvent {
  id: string; // eventId
  sensorId: string;
  rfId: string;
  sensorName: string; // denormalized at write time
  eventType: EventType;
  batteryLow: boolean;
  rssi: number;
  timestamp: Timestamp;
}

// ---- Realtime Database (device-facing) shapes ----

export interface RtdbState {
  armed: boolean;
  siren_active: boolean;
  last_seen?: Record<string, number>;
  battery?: Record<string, BatteryStatus>;
}

export interface RtdbCommands {
  armed: boolean;
  siren: boolean;
}

// Raw event as written by the device (or simulator) to RTDB.
export interface RtdbRawEvent {
  event: string; // "trigger" | "tamper" | "battery_low"
  battery_low: boolean;
  rssi: number;
}

// Condition as written into the RTDB config. Identical to the Firestore
// Condition except that multi_sensor `counts` are keyed by **rfId**, because the
// device only knows rfIds — it never sees Firestore document ids.
export interface RtdbCondition extends Omit<Condition, "counts"> {
  counts?: Record<string, number>; // keyed by rfId
}

// Config object built by onProfileChange and written to RTDB /config.
export interface RtdbConfigSensor {
  name: string;
  enabled: boolean;
  conditions: RtdbCondition[];
}

export interface RtdbConfig {
  armed: boolean;
  siren_duration_sec: number;
  sensors: Record<string, RtdbConfigSensor>; // keyed by rfId
}

// ---- Explore timeline range selector ----

export type TimeRange = "day" | "week" | "month" | "3months" | "year";
