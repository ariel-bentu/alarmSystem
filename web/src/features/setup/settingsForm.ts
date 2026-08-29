/** Pure form state for the project settings page.
 *
 *  Every field — including the checkboxes — is saved by the Save button, not
 *  on change. That makes "have I got unsaved edits?" a real question, so it
 *  gets a real answer: isDirty() drives both the Save button's enabled state
 *  and the warning when leaving the page. */

export interface SettingsForm {
  name: string;
  botToken: string;
  chatId: string;
  sirenDurationSec: number;
  sendTelegram: boolean;
  triggerSiren: boolean;
  notifyEverySensorTrigger: boolean;
}

/** The subset of Project this form edits. */
export interface SettingsSource {
  name: string;
  telegramBotToken: string;
  telegramChatId: string;
  sirenDurationSec: number;
  serverActions: { sendTelegram: boolean; triggerSiren: boolean };
  notifyEverySensorTrigger?: boolean;
}

export function formFromProject(project: SettingsSource): SettingsForm {
  return {
    name: project.name,
    botToken: project.telegramBotToken,
    chatId: project.telegramChatId,
    sirenDurationSec: project.sirenDurationSec,
    sendTelegram: project.serverActions.sendTelegram,
    triggerSiren: project.serverActions.triggerSiren,
    // Absent means enabled — projects predating the field must not read as
    // unchecked, which would silently turn notifications off on first save.
    notifyEverySensorTrigger: project.notifyEverySensorTrigger !== false,
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
    saved.sendTelegram !== current.sendTelegram ||
    saved.triggerSiren !== current.triggerSiren ||
    saved.notifyEverySensorTrigger !== current.notifyEverySensorTrigger
  );
}
