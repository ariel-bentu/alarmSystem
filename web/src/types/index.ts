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
  sirenEnabled: boolean; // false = device never fires the siren
  // IANA zone, e.g. "Asia/Jerusalem". Schedules resolve wall-clock times in
  // it. Optional because project docs predate the field; readers fall back
  // to "UTC".
  timezone?: string;
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
  deadSensorAlertDays: number; // -1 = never alert
  deadAlertSentAt: Timestamp | null; // set when alert fires, cleared when sensor seen
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
  // Fires even when disarmed (smoke, gas). Absent = false: every rule
  // predating this field must keep its armed-only behaviour.
  // The editor restricts this to single-sensor `immediate` rules; the
  // data model deliberately does not encode that restriction.
  always?: boolean;
}

export interface Profile {
  id: string; // profileId = lowercased name, e.g. "away"
  displayName: string;
  createdAt: Timestamp;
  enabled: boolean; // available to arm in Operations; disabled profiles are hidden
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
  boot?: RtdbBoot;
}

// Written once per boot by the firmware. An unexpected `reason` is the only
// way to tell that the device died and silently recovered.
export interface RtdbBoot {
  // "power_on" | "panic" | "twdt" | "brownout" | "sw_restart" | ...
  // See platformResetReason() in firmware/edge/device/src/platform_compat.h.
  reason: string;
  at: number; // epoch ms; 0-adjacent if NTP had not synced yet
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

// Condition as written into the RTDB config. Mirrors functions/src/types.ts
// — keep in sync by hand.
// t: 0=immediate, 1=count_in_window, 2=entry_delay, 3=multi_sensor
export interface RtdbCondition {
  t: 0 | 1 | 2 | 3;
  n?: number;
  w?: number;
  y?: number;
  k?: Record<string, number>; // keyed by index into RtdbConfig.r
  // always-on: 1 when the rule fires regardless of arm state. Omitted when
  // false so the common payload is unchanged (the device polls this every 5s).
  x?: 1;
}

// Device-facing config at RTDB /{projectId}/config. r[i]/c[i] are
// index-aligned: r[i] is a sensor's rfId, c[i] is its condition list.
export interface RtdbConfig {
  a: boolean; // armed
  d: number; // siren_duration_sec
  e: boolean; // siren_enabled (false = never fire)
  r: string[];
  c: RtdbCondition[][];
}

// ---- Explore timeline range selector ----

export type TimeRange = "day" | "week" | "month" | "3months" | "year";
