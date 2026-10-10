/** Pure form state for the Configure → Notifications tab.
 *
 *  SAVE MODEL (applies to every Configure tab carrying former Settings
 *  fields). Controls are split by whether the edit has a moment of
 *  completion:
 *
 *    - checkbox / <select> → saves on change, confirmed by a toast. The edit
 *      IS complete when it changes, so deferring it only risks losing it.
 *    - text / number       → deferred, behind a Save button. There is no such
 *      moment: instant-saving would write `12` on the way to typing `120`,
 *      and would persist a half-typed bot token.
 *
 *  Only the deferred fields are form state here. The instant ones write
 *  straight to Firestore, so putting them in the form would make isDirty()
 *  report changes that are already saved. */

// Relative, not "@/...": this is a VALUE import, so unlike the `import type`
// lines elsewhere in this layer it must resolve at runtime, and the "@" alias
// is not applied when Vitest loads this module as a dependency of its test.
import { DEFAULT_BATTERY_ALERT_MONTHS } from "./batteryAge";

export type NotifyChannel = "telegram" | "pushover";

const ALL_CHANNELS: NotifyChannel[] = ["telegram", "pushover"];

/**
 * Normalises the channel list read from a project doc.
 *
 * `undefined` (and any non-array) yields ["telegram"], matching the server's
 * absent-means-telegram rule, so a legacy project's checkboxes show its real
 * current behaviour. An explicit empty array is preserved: "notify me
 * nowhere" is a real choice.
 *
 * Output is always in ALL_CHANNELS order, which keeps the stored value
 * canonical regardless of the order the boxes were ticked in.
 */
export function normalizeNotifyChannels(input: unknown): NotifyChannel[] {
  if (!Array.isArray(input)) return ["telegram"];
  const seen = new Set(input);
  return ALL_CHANNELS.filter((c) => seen.has(c));
}

/** The DEFERRED fields only — see the save-model note above. */
export interface NotifyForm {
  botToken: string;
  chatId: string;
  pushoverRetrySec: number;
  pushoverExpireSec: number;
  batteryAlertMonths: number;
  /** 0 = off (notify immediately). See JUDGE_WAIT_* below. */
  judgeWaitSec: number;
}

/** Pushover credentials, which live in a DIFFERENT Firestore document to
 *  everything else on this tab: projects/{id}/secrets/notify, admin-only,
 *  deliberately off the member-readable project doc. Kept as its own form so
 *  a failed credential write cannot roll back an unrelated setting, and so
 *  the Save button for it is enabled only by a real credential edit. */
export interface PushoverCredsForm {
  appToken: string;
  userKey: string;
  /** Comma-separated device names; blank = every device on the account. */
  devices: string;
}

export function credsFromSecrets(secrets: {
  pushoverToken?: string;
  pushoverUserKey?: string;
  pushoverDevices?: string;
}): PushoverCredsForm {
  return {
    appToken: secrets.pushoverToken ?? "",
    userKey: secrets.pushoverUserKey ?? "",
    devices: secrets.pushoverDevices ?? "",
  };
}

/** "iphone, ipad ,," → "iphone,ipad" — the shape Pushover's `device` takes.
 *  Mirrors normalizePushoverDevices in functions/src/notifySecrets.ts. */
export function normalizeDevices(raw: string): string {
  return raw
    .split(/[\s,]+/)
    .filter((d) => d !== "")
    .join(",");
}

export function credsDirty(
  saved: PushoverCredsForm,
  current: PushoverCredsForm
): boolean {
  return (
    saved.appToken.trim() !== current.appToken.trim() ||
    saved.userKey.trim() !== current.userKey.trim() ||
    normalizeDevices(saved.devices) !== normalizeDevices(current.devices)
  );
}

/** True once BOTH halves are present. Pushover needs the pair — one alone
 *  sends nothing, which is why notify() checks both before dispatching. */
export function credsComplete(creds: PushoverCredsForm): boolean {
  return creds.appToken.trim() !== "" && creds.userKey.trim() !== "";
}

/** Pushover's built-in sounds, split by whether they LOOP.
 *
 *  The distinction is the whole point of exposing this: priority 2 re-sends
 *  the notification every `retry` seconds rather than sustaining a tone, so a
 *  short sound makes an emergency alert feel like a series of blips instead
 *  of an alarm. Only these five are long.
 *
 *  Hard-coded rather than fetched from /1/sounds.json, which needs the app
 *  token — and that is server-only by design (see notifySecrets.ts). */
export const PUSHOVER_SOUNDS_LONG = [
  "alien",
  "climb",
  "persistent",
  "echo",
  "updown",
] as const;

export const PUSHOVER_SOUNDS_SHORT = [
  "pushover",
  "siren",
  "spacealarm",
  "bugle",
  "bike",
  "cashregister",
  "classical",
  "cosmic",
  "falling",
  "gamelan",
  "incoming",
  "intermission",
  "magic",
  "mechanical",
  "pianobar",
  "tugboat",
  "vibrate",
  "none",
] as const;

/** Clamped to Pushover's own limits, so the UI cannot save a value the API
 *  would reject. pushover.ts clamps again server-side — this is for feedback,
 *  not trust. */
export const RETRY_MIN_SEC = 30;
export const EXPIRE_MAX_SEC = 10800;

/** Judge-gated alerting: how long an alarm notification may wait for the AI
 *  verdict.
 *
 *  0 = OFF, and that is the default — this changes when the owner is woken,
 *  so it must be opted into rather than inherited. It applies only to
 *  NON-definite sensors that have cameras ticked while the project is in
 *  capture+judge (functions/src/judgeDefer.ts owns that gate).
 *
 *  The server's own backstop (PENDING_FALLBACK_SEC) announces a deferred
 *  alarm after 45s if no verdict arrives, so values above that are pointless:
 *  the sweeper fires first. Capped here to say so. */
export const JUDGE_WAIT_OFF = 0;
export const JUDGE_WAIT_MAX_SEC = 45;

/** The subset of Project this form reads. */
export interface NotifySource {
  telegramBotToken: string;
  telegramChatId: string;
  pushoverRetrySec?: number;
  pushoverExpireSec?: number;
  batteryAlertMonths?: number;
  judgeWaitSec?: number;
}

export function formFromProject(project: NotifySource): NotifyForm {
  return {
    botToken: project.telegramBotToken,
    chatId: project.telegramChatId,
    // `??` and NOT `||` throughout: the server clamps these, so a stored 0
    // must reach the input as 0 and be visibly wrong rather than silently
    // replaced by a default the owner never chose. For batteryAlertMonths an
    // explicit 0 is the project-wide "never alert" switch, and `||` would
    // quietly turn it back into 12 months.
    pushoverRetrySec: project.pushoverRetrySec ?? 60,
    pushoverExpireSec: project.pushoverExpireSec ?? 3600,
    batteryAlertMonths:
      project.batteryAlertMonths ?? DEFAULT_BATTERY_ALERT_MONTHS,
    // Absent = off, NOT a default wait: deferring changes when the owner is
    // woken for a real alarm, so it is opt-in.
    judgeWaitSec: project.judgeWaitSec ?? JUDGE_WAIT_OFF,
  };
}

/**
 * True when `current` differs from `saved` in any way a save would persist.
 *
 * Text fields are compared trimmed, because save trims them: without that,
 * typing a trailing space would enable Save and then write a value identical
 * to the stored one.
 */
export function isDirty(saved: NotifyForm, current: NotifyForm): boolean {
  return (
    saved.botToken.trim() !== current.botToken.trim() ||
    saved.chatId.trim() !== current.chatId.trim() ||
    saved.pushoverRetrySec !== current.pushoverRetrySec ||
    saved.pushoverExpireSec !== current.pushoverExpireSec ||
    saved.batteryAlertMonths !== current.batteryAlertMonths ||
    saved.judgeWaitSec !== current.judgeWaitSec
  );
}
