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
  deadSensorAlertDays: number; // -1 = never alert
  deadAlertSentAt: Timestamp | null; // set when alert fires, cleared when sensor seen
}

export interface Profile {
  id: string;
  displayName: string;
  createdAt: Timestamp;
  enabled: boolean;
  isActiveOnDevice: boolean;
  isActiveOnServer: boolean;
}

// A scheduled arming window. armTime is optional (a manual-arm/auto-disarm
// window); disarmTime is required, so every window closes.
// Exactly one of `days` (non-empty) or `date` (non-null) is populated:
// non-empty days = recurring, a set date = one-time.
export interface Schedule {
  id: string;
  name: string;
  enabled: boolean;
  side: "device" | "server";
  profileId: string;
  armTime: string | null; // "HH:MM" local, or null
  disarmTime: string; // "HH:MM" local, required
  days: number[]; // 0-6, Sun-Sat. Empty = one-time
  date: string | null; // "YYYY-MM-DD" for one-time, else null
  // Derived — written only by onScheduleChange/scheduleTick (admin SDK).
  nextArmAt: Timestamp | null;
  nextDisarmAt: Timestamp | null;
  lastFiredAt: Timestamp | null;
  createdAt: Timestamp;
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
  // IANA zone, e.g. "Asia/Jerusalem". Schedules resolve wall-clock times in
  // it. Optional because project docs predate the field; readers fall back
  // to "UTC".
  timezone?: string;
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

// Condition as written into the RTDB config. Short keys and index-based
// references keep the payload small — the device only needs to evaluate
// conditions, not display names, and rfIds are referenced by their position
// in RtdbConfig.r instead of repeating the string.
//
// t: 0=immediate, 1=count_in_window, 2=entry_delay, 3=multi_sensor
// n: count (count_in_window)
// w: window_sec (count_in_window, multi_sensor)
// y: delay_sec (entry_delay)
// k: counts, keyed by index-into-r (as string) — required trigger count per
//    participant, always explicit for every participant including self
export interface RtdbCondition {
  t: 0 | 1 | 2 | 3;
  n?: number;
  w?: number;
  y?: number;
  k?: Record<string, number>;
}

// Device-facing config written to RTDB /{projectId}/config.
// r[i] is a sensor's rfId; c[i] is that same sensor's condition list
// (OR semantics — any one condition firing is enough). r and c are always
// the same length and index-aligned. A sensor whose rfId never appears in r
// is unknown to the device and is not evaluated for alarm logic.
export interface RtdbConfig {
  a: boolean; // armed
  d: number; // siren_duration_sec
  e: boolean; // siren_enabled
  r: string[]; // rfIds, by index
  c: RtdbCondition[][]; // conditions per sensor, index-aligned with r
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
