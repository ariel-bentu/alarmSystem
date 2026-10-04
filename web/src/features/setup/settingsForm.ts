/** Pure form state for the project settings page.
 *
 *  Every field — including the checkboxes — is saved by the Save button, not
 *  on change. That makes "have I got unsaved edits?" a real question, so it
 *  gets a real answer: isDirty() drives both the Save button's enabled state
 *  and the warning when leaving the page. */

// Relative, not "@/...": this is a VALUE import, so unlike the `import type`
// lines elsewhere in this layer it must resolve at runtime, and the "@" alias
// is not applied when Vitest loads this module as a dependency of its test.
import { DEFAULT_BATTERY_ALERT_MONTHS } from "../configure/batteryAge";

export type NotifyChannel = "telegram" | "pushover";

const ALL_CHANNELS: NotifyChannel[] = ["telegram", "pushover"];

/**
 * Normalises the channel list read from a project doc or a form.
 *
 * `undefined` (and any non-array) yields ["telegram"], matching the server's
 * absent-means-telegram rule, so a legacy project's checkboxes show its real
 * current behaviour. An explicit empty array is preserved: "notify me
 * nowhere" is a real choice.
 *
 * Output is always in ALL_CHANNELS order, which is what lets isDirty compare
 * the two lists by value without a reordering reading as an edit.
 */
export function normalizeNotifyChannels(input: unknown): NotifyChannel[] {
  if (!Array.isArray(input)) return ["telegram"];
  const seen = new Set(input);
  return ALL_CHANNELS.filter((c) => seen.has(c));
}

export interface SettingsForm {
  name: string;
  botToken: string;
  chatId: string;
  sirenDurationSec: number;
  timezone: string;
  sendTelegram: boolean;
  triggerSiren: boolean;
  notifyEverySensorTrigger: boolean;
  batteryAlertMonths: number;
  notifyChannels: NotifyChannel[];
}

/** The subset of Project this form edits. */
export interface SettingsSource {
  name: string;
  telegramBotToken: string;
  telegramChatId: string;
  sirenDurationSec: number;
  timezone?: string;
  serverActions: { sendTelegram: boolean; triggerSiren: boolean };
  notifyEverySensorTrigger?: boolean;
  batteryAlertMonths?: number;
  notifyChannels?: NotifyChannel[];
}

export function formFromProject(project: SettingsSource): SettingsForm {
  return {
    name: project.name,
    botToken: project.telegramBotToken,
    chatId: project.telegramChatId,
    sirenDurationSec: project.sirenDurationSec,
    // Projects predating the field fall back to the BROWSER's zone, not UTC.
    // Offering UTC would invite the user to save it, producing exactly the
    // silent hour-long drift the zone exists to prevent; the browser's zone
    // is almost always right, since the alarm is in the house they are in.
    timezone:
      project.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone,
    sendTelegram: project.serverActions.sendTelegram,
    triggerSiren: project.serverActions.triggerSiren,
    // Absent means enabled — projects predating the field must not read as
    // unchecked, which would silently turn notifications off on first save.
    notifyEverySensorTrigger: project.notifyEverySensorTrigger !== false,
    // `??` and NOT `||`: an explicit 0 is the project-wide "never alert"
    // switch, and `||` would silently replace it with the 12-month default.
    batteryAlertMonths:
      project.batteryAlertMonths ?? DEFAULT_BATTERY_ALERT_MONTHS,
    // Absent means ["telegram"] server-side, so the checkboxes must show
    // that rather than appearing to have nothing selected.
    notifyChannels: normalizeNotifyChannels(project.notifyChannels),
  };
}

/**
 * True when `current` differs from `saved` in any way that a save would
 * persist.
 *
 * Text fields are compared trimmed, because save trims them: without that,
 * typing a trailing space would enable Save and then write a value identical
 * to the stored one.
 */
export function isDirty(saved: SettingsForm, current: SettingsForm): boolean {
  return (
    saved.name.trim() !== current.name.trim() ||
    saved.botToken.trim() !== current.botToken.trim() ||
    saved.chatId.trim() !== current.chatId.trim() ||
    saved.sirenDurationSec !== current.sirenDurationSec ||
    saved.timezone !== current.timezone ||
    saved.sendTelegram !== current.sendTelegram ||
    saved.triggerSiren !== current.triggerSiren ||
    saved.notifyEverySensorTrigger !== current.notifyEverySensorTrigger ||
    saved.batteryAlertMonths !== current.batteryAlertMonths ||
    // Compared by VALUE, not reference: these are arrays, so `!==` would be
    // true on every render and leave Save permanently enabled. Both sides
    // come from normalizeNotifyChannels, so the order is already stable and
    // a join is a sound comparison.
    saved.notifyChannels.join(",") !== current.notifyChannels.join(",")
  );
}
