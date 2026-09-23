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
  | "disarmed"
  // Controller lifecycle, not sensor activity. These have no rfId, battery or
  // RSSI — the UI renders them as system rows (see isRadioEvent in
  // ExplorePage). Added because a device that crashed, went offline and came
  // back left NO trace in the timeline: diagnosing the 2026-09-04 outage meant
  // reconstructing it from raw RTDB nodes and heartbeat arithmetic.
  | "device_restart"
  | "device_offline"
  | "device_online";

export interface Condition {
  type: ConditionType;
  count?: number;
  window_sec?: number;
  delay_sec?: number;
  // multi_sensor only: per-sensor trigger counts required inside window_sec.
  // Missing entries default to 1. A sensor is "satisfied" once it reaches its
  // own count within the window.
  counts?: Record<string, number>;
  // multi_sensor only: how many of the rule's sensors must be satisfied for
  // it to fire ("2 of 3"). ABSENT means all of them — the original AND — so
  // rules predating this field need no migration. Clamped, never trusted
  // raw: see quorumOf() in alarmLogic.ts.
  quorum?: number;
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
  // When the battery was last replaced, as recorded by a human — NOT
  // reported by the sensor (batteryStatus is the sensor's own claim, and the
  // two are independent: see batteryAgeCheck.ts).
  //
  // Optional and nullable: sensor docs predate the field. Absent or null
  // means never recorded, and readers fall back to pairedAt so that every
  // sensor has an age from the day it was paired.
  batteryChangedAt?: Timestamp | null;
  // Set when the stale-battery alert fires, cleared when batteryChangedAt is
  // written. Mirrors deadAlertSentAt: without it the daily check would send
  // the same Telegram every noon until the battery was replaced.
  batteryAlertSentAt?: Timestamp | null;
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
  // Months after which a sensor battery is considered overdue for
  // replacement. Optional: project docs predate it, and absent means the
  // DEFAULT_BATTERY_ALERT_MONTHS default. Zero or negative disables the
  // stale-battery alert for the whole project.
  batteryAlertMonths?: number;
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
// q: multi_sensor quorum — how many participants must reach their own count
//    ("2 of 3"). Omitted when it equals the participant count, which is the
//    AND every rule used to have, so the common payload is unchanged. The
//    firmware reads an absent q as 0, meaning "all" (Condition::q).
// x: always-on — 1 when the rule fires regardless of arm state. Omitted when
//    false so the common payload is unchanged (the device polls this every 5s).
export interface RtdbCondition {
  t: 0 | 1 | 2 | 3;
  n?: number;
  w?: number;
  y?: number;
  k?: Record<string, number>;
  q?: number;
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

// Who caused an arm/disarm. The cloud sources (app/schedule/telegram) come
// from commands/armed_via, written by whoever set commands/armed; the device
// ones (remote/local/cloud) from state/armed_by via parseArmSource.
export type ArmSource =
  | "app"
  | "schedule"
  | "telegram"
  | "remote"
  | "local"
  | "cloud";

export interface AlarmEvent {
  id: string;
  sensorId: string;
  rfId: string;
  sensorName: string;
  eventType: EventType;
  batteryLow: boolean;
  rssi: number;
  timestamp: Timestamp;
  // Arm/disarm rows only, and ABSENT on rows written before this field
  // existed. sensorName alone is ambiguous — it holds a PROFILE name on a
  // cloud arm but a REMOTE's name on a device one, and the UI rendered every
  // unrecognised value as "Remote <name>", inventing remotes that were never
  // used. Optional rather than backfilled: historical rows genuinely cannot
  // be attributed, and the UI degrades them to a plain name.
  armSource?: ArmSource;
}
