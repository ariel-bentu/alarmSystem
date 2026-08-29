import { describe, it, expect } from "vitest";
import { type SettingsForm, formFromProject, isDirty } from "./settingsForm";

const base: SettingsForm = {
  name: "Home",
  botToken: "tok",
  chatId: "-100",
  sirenDurationSec: 120,
  sendTelegram: true,
  triggerSiren: false,
  notifyEverySensorTrigger: true,
};

describe("isDirty", () => {
  it("is false when nothing has changed", () => {
    expect(isDirty(base, { ...base })).toBe(false);
  });

  it("detects a changed text field", () => {
    expect(isDirty(base, { ...base, name: "Office" })).toBe(true);
  });

  it("detects a changed number field", () => {
    expect(isDirty(base, { ...base, sirenDurationSec: 60 })).toBe(true);
  });

  it("detects a toggled checkbox", () => {
    expect(isDirty(base, { ...base, triggerSiren: true })).toBe(true);
    expect(isDirty(base, { ...base, sendTelegram: false })).toBe(true);
    expect(isDirty(base, { ...base, notifyEverySensorTrigger: false })).toBe(true);
  });

  it("is false again once a field is changed back", () => {
    const edited = { ...base, name: "Office" };
    expect(isDirty(base, edited)).toBe(true);
    expect(isDirty(base, { ...edited, name: "Home" })).toBe(false);
  });

  // Trailing whitespace is stripped on save, so " Home " would otherwise
  // enable Save and then save a value identical to what was already stored.
  it("ignores leading/trailing whitespace in text fields", () => {
    expect(isDirty(base, { ...base, name: "  Home  " })).toBe(false);
    expect(isDirty(base, { ...base, botToken: " tok " })).toBe(false);
    expect(isDirty(base, { ...base, chatId: "-100 " })).toBe(false);
  });

  it("treats a whitespace-only change to an empty field as clean", () => {
    const empty = { ...base, botToken: "" };
    expect(isDirty(empty, { ...empty, botToken: "   " })).toBe(false);
  });
});

describe("formFromProject", () => {
  it("reads the project's values", () => {
    const form = formFromProject({
      name: "Home",
      telegramBotToken: "tok",
      telegramChatId: "-100",
      sirenDurationSec: 90,
      serverActions: { sendTelegram: true, triggerSiren: true },
      notifyEverySensorTrigger: false,
    });
    expect(form).toEqual({
      name: "Home",
      botToken: "tok",
      chatId: "-100",
      sirenDurationSec: 90,
      sendTelegram: true,
      triggerSiren: true,
      notifyEverySensorTrigger: false,
    });
  });

  // Projects created before the field existed have no value; the app treats
  // "absent" as enabled, so the checkbox must not read as unchecked.
  it("defaults a missing notifyEverySensorTrigger to true", () => {
    const form = formFromProject({
      name: "Home",
      telegramBotToken: "",
      telegramChatId: "",
      sirenDurationSec: 120,
      serverActions: { sendTelegram: false, triggerSiren: false },
      notifyEverySensorTrigger: undefined,
    });
    expect(form.notifyEverySensorTrigger).toBe(true);
  });
});
