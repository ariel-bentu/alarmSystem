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
  // Kerui nibble 0x5. Notified once per condition (see waterAlertSentAt),
  // never sirened and never fed to alarm rules.
  | "water"
  // Kerui nibble 0x3 or 0x7. Mirrored to the timeline so history is
  // complete, but drives NOTHING: no siren, no notification, no rule
  // evaluation, no status. The system has no concept of a door's open/closed
  // STATE, only of events; adding one is separate work. Recorded as a
  // decision, not an oversight.
  | "close"
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
  // count_in_window only: minimum seconds between two triggers for the second
  // to count as a SEPARATE witness. ABSENT or 0 means no minimum, which is
  // what every rule predating this field means — so no migration.
  //
  // Why it exists: a PIR re-triggering on its own stimulus is one physical
  // event, and a bare count_in_window counts that echo as corroboration.
  // Measured on sensor 0x009BFA (992 events): median gap between the 1st and
  // 2nd trigger of a burst is 10s, and 51% of multi-trigger bursts are <=10s.
  //
  // Pair it with a WIDER window_sec, not the default. Against a 30s window,
  // min_gap_sec 20 leaves only a [20,30] slot — 20 of 193 real bursts — which
  // suppresses genuine two-pass movement too. 20/120 is the shape that works.
  //
  // Mirrored by Condition::g in the firmware's alarm_state.h; the two
  // evaluators must agree or device and server disagree about the alarm.
  min_gap_sec?: number;
  // A `breach` verdict from the AI judge satisfies this condition ON ITS OWN:
  // for count_in_window, without the trigger count being met; for
  // multi_sensor, without the other participants triggering. ABSENT = false,
  // so no migration and every existing rule is unchanged.
  //
  // Why: count_in_window is a PROXY for "is this a person, not a cat", and a
  // breach verdict answers that question directly. Two unjudged triggers are
  // WEAKER evidence than one trigger plus a person visibly in frame — a cat
  // pacing a yard satisfies 2-in-30s. So the count is the fallback for when
  // vision is unavailable, not the gold standard the judge merely filters.
  //
  // On multi_sensor it satisfies the WHOLE rule, regardless of `quorum`: the
  // AND exists because any one PIR is noisy, and vision removes exactly that
  // noise. Satisfying only the one participant would leave the rule waiting
  // for a sensor that may never trigger.
  //
  // CLOUD-SIDE ONLY, and deliberately not mirrored into the device config: a
  // verdict only exists where there are cameras and an LLM. The device keeps
  // evaluating the plain count/AND, which is exactly the offline fallback —
  // "alarm logic never depends on the cloud" is preserved. The judge's alarm
  // reaches the device as /{projectId}/commands/breach.
  //
  // Resolution across a sensor's several conditions is OR — see
  // breachSatisfiesAny() in judgeGate.ts for why the firing rule cannot (and
  // need not) be identified.
  breach_satisfies?: boolean;
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
  // The full 24-bit code first seen at pairing, e.g. "0xA1B2C3". KEPT, but
  // now DESCRIPTIVE: it is what the Sensors tab shows and what the migration
  // read, not the matching key. Matching moved to familyId.
  rfId: string;
  // The 20-bit identity, e.g. "0x0061D" — five upper-case hex digits. THIS
  // IS THE MATCHING KEY. A Kerui packet's bottom nibble is an event code, so
  // one physical sensor emits several 24-bit codes (0x0061DA motion,
  // 0x0061DB tamper); matching on the full code made each look like a
  // separate, unpaired sensor.
  //
  // Optional because sensor docs predate it and the migration
  // (functions/scripts/migrateFamilyIds.ts) backfills them; readers derive
  // it from rfId when absent, so an unmigrated doc still matches.
  familyId?: string;
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
  // Is a trigger from this sensor a confirmed break-in on its own?
  //
  // ABSENT MEANS TRUE. A door opening is definite; motion is not. The tier of
  // the alarm notification follows from it: definite -> Pushover priority 2
  // (repeats until acknowledged, breaks through a muted ringer),
  // non-definite -> priority 0 (a normal notification, which RESPECTS mute
  // and Do Not Disturb) which the AI judge can escalate to priority 2 on a
  // breach verdict. Priority 1 is deliberately unused: Pushover applies
  // Critical Alerts to it as well as 2, so it broke through mute too and the
  // two tiers were indistinguishable by ear. See severityToPriority.
  //
  // Absent defaults to definite so a newly paired sensor wakes the owner,
  // matching the fail-loud stance elsewhere (a missing judge key yields a
  // NullJudge that fails to "breach").
  //
  // NOT a device-visible field: the device never learns about certainty, and
  // it is deliberately excluded from sensorConfigChanged's guard.
  definiteBreach?: boolean;
  // Set when the stale-battery alert fires, cleared when batteryChangedAt is
  // written. Mirrors deadAlertSentAt: without it the daily check would send
  // the same alert every noon until the battery was replaced.
  //
  // ALSO the once-marker for a sensor-REPORTED battery_low event (Kerui
  // nibble 0xF), cleared by onSensorEvent on the next normal trigger.
  // Deliberately ONE field, not two: both mean "the user has already been
  // told this battery needs attention", and a second field would let the same
  // sensor send two different battery alerts for the same battery.
  batteryAlertSentAt?: Timestamp | null;
  // Set when a water alert (Kerui nibble 0x5) fires, cleared when the sensor
  // next reports a normal trigger. "Once" means once per CONDITION, not once
  // ever — without the marker a leaking sensor would alert on every
  // packet, which is every few seconds. Same shape as deadAlertSentAt.
  waterAlertSentAt?: Timestamp | null;
  // NVR channels (1-8) to snapshot when this sensor triggers. AUTHORITATIVE:
  // absent or empty means capture NOTHING for this sensor — it does not fall
  // back to "all channels". Replaces the earlier outOfSight + cameraChannel
  // pair, which could express only none-or-one.
  cameras?: number[];
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
  // "Notify even when the siren is suppressed" — see onSensorEvent, the only
  // reader: it is consulted ONLY when triggerSiren is off, because when the
  // siren fires onAlarm sends the notification instead. Renamed from
  // sendTelegram on 2026-10-05; it has gated both channels since Pushover.
  // No dual-read fallback: the Firestore field was renamed by hand, so an
  // unmigrated doc reads undefined → falsy and sends nothing.
  sendNotification: boolean;
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

/**
 * A notification channel. Projects may enable either, both, or neither.
 *
 * Pushover exists because a muted iPhone silences every Telegram
 * notification; see pushover.ts.
 */
export type NotifyChannel = "telegram" | "pushover";

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
  // Which notification channels are enabled.
  //
  // ABSENT means ["telegram"] — every project predating this field keeps
  // behaving exactly as before, with no migration. An EMPTY ARRAY means send
  // nothing, which is a legitimate choice and is NOT coerced to the default.
  //
  // Not a secret, so it belongs here where the web UI can read and write it.
  // The Pushover CREDENTIALS deliberately do not live on this doc — see
  // notifySecrets.ts.
  notifyChannels?: NotifyChannel[];
  // Mirror of "a Pushover credential has been written", maintained by the
  // set:notifyKey script. Exists only so the settings UI can show whether
  // Pushover is set up: the client cannot read the secret itself.
  pushoverConfigured?: boolean;
  // Priority-2 repeat interval and give-up window, in seconds. Optional:
  // absent means pushover.ts's DEFAULT_RETRY_SEC / DEFAULT_EXPIRE_SEC. Values
  // are clamped to the API's own bounds (retry >= 30, expire <= 10800).
  pushoverRetrySec?: number;
  pushoverExpireSec?: number;
  // A built-in Pushover sound name ("siren", "persistent", …). Absent or
  // empty means the user's own default tone.
  //
  // Only alien / climb / persistent / echo / updown are long-looping; the
  // rest are short one-shots, and priority 2's repeat re-sends the
  // notification rather than sustaining a tone — so a short sound is why an
  // emergency alert can fail to FEEL like a repeating alarm.
  pushoverSound?: string;
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
  // Grab trigger snapshots while DISARMED too. Absent = true (the behaviour
  // before this field). false = only while armed, or when the trigger raised
  // an alarm (an `always` rule). Device-visible as RtdbConfig `cd`.
  captureWhenDisarmed?: boolean;
  // Days to retain snapshots before deletion. Optional: absent uses default.
  snapshotRetentionDays?: number;
  // Judge provider for alarm-cause analysis. Optional: absent means no judgment.
  // The API key is NOT here — it lives in the server-only `config/judge` doc
  // (see judgeConfig.ts), because this project doc is member-readable.
  judgeProvider?: "claude" | "gemini" | "null";
  // LLM model for judging. Optional: absent uses the provider's default.
  judgeModel?: string;
  // Custom prompt for judge context. Optional: uses default when absent.
  judgePrompt?: string;
  // Human names for NVR channels, keyed by channel number ({"1":"Front door"}).
  // Used in the judge prompt and the breach alert caption; channels with no
  // entry fall back to "camera N". The device never sees these.
  cameraNames?: Record<string, string>;
  // How long an alarm notification may wait for the AI judge's verdict, in
  // seconds. ABSENT or 0 = today's behaviour: onAlarm notifies immediately.
  //
  // Applies ONLY to non-definite sensors with cameras ticked while the project
  // is in capture+judge — see shouldDeferToJudge(). When it applies, onAlarm
  // sends nothing and the verdict decides the tier, so a false positive never
  // wakes anyone. doSchedule's sweeper is the backstop if no verdict arrives;
  // the value is the age at which it gives up and sends the fallback.
  judgeWaitSec?: number;
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
// g: min_gap_sec (count_in_window) — minimum seconds between two triggers for
//    the second to count as a separate witness. Omitted when unset or 0, so
//    the common payload is unchanged; the firmware reads an absent g as 0,
//    meaning "no minimum" (Condition::g).
// x: always-on — 1 when the rule fires regardless of arm state. Omitted when
//    false so the common payload is unchanged (the device polls this every 5s).
export interface RtdbCondition {
  t: 0 | 1 | 2 | 3;
  n?: number;
  w?: number;
  y?: number;
  k?: Record<string, number>;
  q?: number;
  g?: number;
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
  // 0 = no trigger snapshots while disarmed. Omitted (device default: capture)
  // unless the project turned captureWhenDisarmed off.
  cd?: 0;
  // Per-sensor camera bitmask, index-aligned with r: channel N is bit N-1, so
  // channel 1 is 0x01 and channel 8 is 0x80. 0 means this sensor captures
  // nothing. Omitted entirely when every mask is 0.
  cmask?: number[];
  // Siren hold, seconds: how long the DEVICE delays sounding the siren for a
  // non-definite sensor, giving the AI judge time to rule it a false positive
  // (/commands/fp cancels the pending siren). Omitted when 0/unset, which is
  // "fire immediately" — the behaviour before this field.
  //
  // The device fires the siren locally with no cloud involvement, which is why
  // this has to travel to it at all. The hold EXPIRES AND FIRES: an offline
  // device, a down NVR or a judge error still sounds the siren, just late.
  sh?: number;
  // Indices into r whose sensors are NOT definite breaches, i.e. the ones the
  // hold above applies to. Omitted when empty — absent certainty means
  // DEFINITE (see breachCertainty.ts), so the common payload is unchanged for
  // a project that has never ticked the box.
  nd?: number[];
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
