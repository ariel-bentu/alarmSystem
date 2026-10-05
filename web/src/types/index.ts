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
  // Kerui nibble 0x5 — notified once per condition, never sirened.
  | "water"
  // Kerui nibble 0x3 or 0x7. In the timeline so history is complete, but
  // drives nothing: no siren, no Telegram, no rule evaluation. The system
  // has no concept of a door's open/closed STATE, only of events.
  | "close"
  | "alarm"
  | "armed"
  | "disarmed"
  // Controller lifecycle. Mirrors functions/src/types.ts — keep the two in
  // step. Rendered as system rows: no battery, no RSSI, muted styling.
  | "device_restart"
  | "device_offline"
  | "device_online";

// ---- Firestore documents ----

export interface ServerActions {
  // Despite the shorter name, this means "notify even when the siren is
  // suppressed": onSensorEvent reads it ONLY in the else-branch of
  // triggerSiren, because when the siren fires onAlarm sends the
  // notification. With triggerSiren on it has no effect. Renamed from
  // sendTelegram on 2026-10-05 — it has gated both channels since Pushover
  // landed.
  sendNotification: boolean;
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
  // Which notification channels are enabled. ABSENT means ["telegram"] —
  // projects predating the field keep behaving as before. An EMPTY ARRAY
  // means send nothing and is not coerced to the default.
  notifyChannels?: ("telegram" | "pushover")[];
  // Read-only mirror maintained by the set:notifyKey script. The credentials
  // themselves live in a server-only subcollection no client may read.
  pushoverConfigured?: boolean;
  // Built-in Pushover sound name; absent/"" means the user's default tone.
  // Only alien/climb/persistent/echo/updown loop — see
  // features/configure/notifySettings.ts.
  pushoverSound?: string;
  // Priority-2 repeat interval and give-up window, in seconds.
  pushoverRetrySec?: number;
  pushoverExpireSec?: number;
  // Months after which a sensor battery is considered overdue for
  // replacement. Optional: project docs predate it, and absent means the
  // DEFAULT_BATTERY_ALERT_MONTHS default. Zero or negative disables the
  // stale-battery alert for the whole project.
  batteryAlertMonths?: number;
  // NVR mode — off disables snapshot capture. Optional: absent means off.
  nvrMode?: "off" | "capture" | "capture+judge";
  // NVR host address. Optional: required only when nvrMode is not off.
  nvrHost?: string;
  // NVR port. Optional: required only when nvrMode is not off.
  nvrPort?: number;
  // NVR user for authentication. Optional: required only when nvrMode is not off.
  nvrUser?: string;
  // NVR password for authentication. Optional: required only when nvrMode is not off.
  nvrPassword?: string;
  // Seconds to wait before allowing next snapshot after trigger. Optional: absent uses default.
  captureCooldownSec?: number;
  // Days to retain snapshots before deletion. Optional: absent uses default.
  snapshotRetentionDays?: number;
  // Judge provider for alarm-cause analysis. Optional: absent means no judgment.
  // The API key is NOT here, and must never be added: this doc is readable by
  // every project member. Keys live in the server-only `config/judge` doc,
  // which no client can read (firestore.rules).
  judgeProvider?: "claude" | "gemini" | "null";
  // LLM model for judging. Optional: absent uses the provider's default.
  judgeModel?: string;
  // Custom prompt for judge context. Optional: uses default when absent.
  judgePrompt?: string;
  // Human names for NVR channels, keyed by channel number ({"1":"Front door"}).
  // Display-only: the device captures by number and never sees these. Channels
  // with no entry render as "Camera N" — see features/explore/cameraNames.ts.
  cameraNames?: Record<string, string>;
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

// A 433MHz remote control. Kept SEPARATE from Sensor deliberately: a sensor
// means "can trigger the alarm", a remote means "can control the alarm".
// Merging them would let a rule be built on a remote button — e.g. arming
// the house when disarm is pressed — which has no legitimate use.
export interface Remote {
  id: string; // remoteId
  // Hex, 20-bit, e.g. "0xE45CA" — the identity only. The button lives in the
  // bottom nibble of the transmitted code and is never stored.
  identity: string;
  name: string;
  pairedAt: Timestamp;
  lastSeen: Timestamp | null;
}

export interface Sensor {
  id: string; // sensorId
  // The full 24-bit code first seen at pairing, e.g. "0xA1B2C3". KEPT, but
  // DESCRIPTIVE: it is what this tab shows, not the matching key.
  rfId: string;
  // The 20-bit identity, e.g. "0x0061D". THIS IS THE MATCHING KEY. A Kerui
  // packet's bottom nibble is an event code, so one physical sensor emits
  // several 24-bit codes (0x0061DA motion, 0x0061DB tamper) — matching on
  // the full code made each look like a separate, unpaired sensor.
  //
  // Optional: sensor docs predate it and the migration backfills them;
  // readers derive it from rfId when absent (see keruiEvent.familyIdOf).
  familyId?: string;
  name: string;
  pairedAt: Timestamp;
  batteryStatus: BatteryStatus;
  lastSeen: Timestamp | null;
  deadSensorAlertDays: number; // -1 = never alert
  deadAlertSentAt: Timestamp | null; // set when alert fires, cleared when sensor seen
  // When the battery was last replaced, as recorded by a human — NOT
  // reported by the sensor (batteryStatus is the sensor's own claim, and the
  // two are independent: see batteryAge.ts).
  //
  // Optional and nullable: sensor docs predate the field. Absent or null
  // means never recorded, and readers fall back to pairedAt so that every
  // sensor has an age from the day it was paired.
  batteryChangedAt?: Timestamp | null;
  // Is a trigger from this sensor a confirmed break-in on its own?
  // ABSENT MEANS TRUE — see functions/src/breachCertainty.ts, which owns
  // this default. Definite sends a repeating emergency push; non-definite
  // sends a loud single-shot push the AI judge can escalate.
  definiteBreach?: boolean;
  // Set when the stale-battery alert fires, cleared when batteryChangedAt is
  // written. Mirrors deadAlertSentAt: without it the daily check would send
  // the same Telegram every noon until the battery was replaced.
  // ALSO the once-marker for a sensor-reported battery_low event (nibble
  // 0xF) — one field, so one battery cannot produce two alerts.
  batteryAlertSentAt?: Timestamp | null;
  // Set when a water alert (nibble 0x5) fires, cleared when the sensor next
  // reports a normal trigger. Once per CONDITION, not once ever.
  waterAlertSentAt?: Timestamp | null;
  // NVR channels (1-8) to snapshot when this sensor triggers. AUTHORITATIVE:
  // absent or empty means capture NOTHING for this sensor — it does not fall
  // back to "all channels". Replaces the earlier outOfSight + cameraChannel
  // pair, which could express only none-or-one.
  cameras?: number[];
}

export interface Condition {
  type: ConditionType;
  count?: number; // count_in_window
  window_sec?: number; // count_in_window, multi_sensor
  delay_sec?: number; // entry_delay
  // multi_sensor only: per-sensor trigger counts required inside window_sec.
  // Missing entries default to 1. A sensor is "satisfied" once it reaches its
  // own count within the window.
  counts?: Record<string, number>;
  // multi_sensor only: how many of the rule's sensors must be satisfied for
  // it to fire ("2 of 3"). ABSENT means all of them — the original AND — so
  // rules predating this field keep their behaviour untouched.
  quorum?: number;
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

// Who caused an arm/disarm. The cloud sources (app/schedule/telegram) come
// from commands/armed_via; the device ones (remote/local/cloud) from
// state/armed_by via parseArmSource in the functions.
export type ArmSource =
  | "app"
  | "schedule"
  | "telegram"
  | "remote"
  | "local"
  | "cloud";

export interface AlarmEvent {
  id: string; // eventId
  sensorId: string;
  rfId: string;
  sensorName: string; // denormalized at write time
  eventType: EventType;
  batteryLow: boolean;
  rssi: number;
  timestamp: Timestamp;
  // Arm/disarm rows only, and ABSENT on rows written before this field
  // existed. Disambiguates sensorName, which holds a profile name for a cloud
  // arm but a remote's name for a device one — see eventSubject().
  armSource?: ArmSource;
}

// A SEPARATE collection from `events` — written by onSnapshotUploaded (Task
// 13), one doc per {rfId, ts} trigger, id `{rfId}_{ts}`. Joined onto
// AlarmEvent rows in ExplorePage by that same key (rfId + timestamp.toMillis()
// as epoch-ms), NOT embedded on the event doc itself.
export interface TimelineSnapshotDoc {
  id: string; // `${rfId}_${ts}`
  rfId?: string;
  sensorId?: string | null;
  sensorName?: string;
  timestamp?: Timestamp;
  snapshots?: { channel: number; url: string }[];
  // Free-text AI note, written only when the project's judge ran. There is
  // NO structured verdict field on this doc — onSnapshotUploaded embeds the
  // verdict in this string ("confirmed breach (AI): ...", "false positive
  // (AI): ...", or a withheld-advisory variant that also starts "safe (AI,
  // channel N): ..."). snapshotSummary() parses it back out for the badge.
  aiNote?: string;
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
  // NVR host. Omitted when NVR is off.
  nh?: string;
  // NVR port. Omitted when NVR is off.
  np?: number;
  // NVR user. Omitted when NVR is off.
  nu?: string;
  // NVR password. Omitted when NVR is off.
  nw?: string;
  // NVR mode: 0=off, 1=capture, 2=capture+judge. Omitted when NVR is off.
  nm?: 0 | 1 | 2;
  // Capture cooldown in seconds. Omitted when using default.
  cc?: number;
  // Per-sensor camera bitmask, index-aligned with r: channel N is bit N-1, so
  // channel 1 is 0x01 and channel 8 is 0x80. 0 means this sensor captures
  // nothing. Omitted entirely when every mask is 0.
  cmask?: number[];
}
