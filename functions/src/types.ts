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
  // Fires even when disarmed (smoke, gas). Absent = false: every rule
  // predating this field must keep its armed-only behaviour.
  // The editor restricts this to single-sensor `immediate` rules; the
  // data model deliberately does not encode that restriction.
  always?: boolean;
}

// A 433MHz remote control. Kept SEPARATE from Sensor deliberately: a sensor
// means "can trigger the alarm", a remote means "can control the alarm".
// Merging them would let a rule be built on a remote button — e.g. arming
// the house when disarm is pressed — which has no legitimate use.
export interface Remote {
  id: string;
  // Hex, 20-bit, e.g. "0xE45CA" — the identity only. The button lives in the
  // bottom nibble of the transmitted code and is never stored.
  identity: string;
  name: string;
  pairedAt: Timestamp;
  lastSeen: Timestamp | null;
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
  // Server wall-clock time of the last heartbeat, stamped by onHeartbeat.
  // The RTDB value the device writes is UPTIME, not epoch, so this is the
  // only field from which "how long has it been silent" can be computed.
  lastSeen: Timestamp | null;
  // Set when an offline alert has been sent, cleared when the device
  // returns. Latches the alert so one outage sends one message, and marks
  // when the outage was noticed so the recovery message can report its
  // length. Absent (not null) when online — see deviceLiveness.ts.
  offlineAlertSentAt?: Timestamp;
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
  // The device's EV1527 identity for its siren, as "0xRRGGBB" — the same
  // string form the device reports and that Remote.identity uses.
  //
  // The DEVICE generates this (from its hardware RNG) and owns it; this
  // field is the durable record, written by onSirenAddress when the device
  // reports it. It exists because the device's only other copy is in EEPROM,
  // and an EEPROM magic bump (e.g. adding a Config field) discards the whole
  // record — which silently lost a physical siren pairing, since the siren
  // stays bound to an address the device no longer knows.
  //
  // Pushed back down as RtdbConfig.s so a wiped device re-adopts it instead
  // of minting a new address the siren has never heard.
  //
  // Optional: project docs predate the field, and a project whose device has
  // never reported one simply has no siren address yet.
  sirenBaseAddress?: string;
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
// x: always-on — 1 when the rule fires regardless of arm state. Omitted when
//    false so the common payload is unchanged (the device polls this every 5s).
export interface RtdbCondition {
  t: 0 | 1 | 2 | 3;
  n?: number;
  w?: number;
  y?: number;
  k?: Record<string, number>;
  x?: 1;
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
  // Paired remote identities (20-bit, as numbers). Omitted entirely when
  // none are paired — RTDB drops empty arrays on .set(), so the firmware's
  // parser treats an absent m as "zero remotes", never a parse failure.
  m?: number[];
  // Siren base address (24-bit, as a NUMBER — Firestore stores the "0x..."
  // string form, this is the parsed value, same split as `m`). Omitted when
  // the project has no siren address yet.
  //
  // The device adopts this ONLY when its own EEPROM copy is missing; a
  // device that already has a valid address ignores it and stays
  // authoritative. See main.cpp's applyPendingConfigUpdate().
  //
  // Single value, not an array: multi-siren is a TODO (see todo.txt), and
  // the firmware TX path drives one address today.
  s?: number;
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
