import { describe, it, expect } from "vitest";
import {
  type SettingsForm,
  formFromProject,
  isDirty,
  normalizeNotifyChannels,
} from "./settingsForm";
import { DEFAULT_BATTERY_ALERT_MONTHS } from "@/features/configure/batteryAge";

const base: SettingsForm = {
  name: "Home",
  botToken: "tok",
  chatId: "-100",
  sirenDurationSec: 120,
  timezone: "Asia/Jerusalem",
  sendTelegram: true,
  triggerSiren: false,
  notifyEverySensorTrigger: true,
  batteryAlertMonths: DEFAULT_BATTERY_ALERT_MONTHS,
  notifyChannels: ["telegram"],
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
      timezone: "Asia/Jerusalem",
      serverActions: { sendTelegram: true, triggerSiren: true },
      notifyEverySensorTrigger: false,
    });
    expect(form).toEqual({
      name: "Home",
      botToken: "tok",
      chatId: "-100",
      sirenDurationSec: 90,
      timezone: "Asia/Jerusalem",
      sendTelegram: true,
      triggerSiren: true,
      notifyEverySensorTrigger: false,
      batteryAlertMonths: DEFAULT_BATTERY_ALERT_MONTHS,
      notifyChannels: ["telegram"],
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

  // Projects predating the timezone field fall back to the browser's zone
  // rather than to UTC. Showing UTC would invite the user to save it, which
  // is exactly the silent-hour-drift outcome the zone exists to prevent —
  // whereas the browser's zone is almost always the right answer.
  it("defaults a missing timezone to the browser's zone", () => {
    const form = formFromProject({
      name: "Home",
      telegramBotToken: "",
      telegramChatId: "",
      sirenDurationSec: 120,
      serverActions: { sendTelegram: false, triggerSiren: false },
      timezone: undefined,
    });
    expect(form.timezone).toBe(
      Intl.DateTimeFormat().resolvedOptions().timeZone
    );
  });
});

describe("batteryAlertMonths", () => {
  // formFromProject takes a SettingsSource (the Project subset), not a
  // SettingsForm, so this fixture is separate from `base` above.
  const source = {
    name: "Home",
    telegramBotToken: "tok",
    telegramChatId: "-100",
    sirenDurationSec: 120,
    timezone: "Asia/Jerusalem",
    serverActions: { sendTelegram: true, triggerSiren: false },
  };

  it("defaults to a year when the project has no value", () => {
    // Project docs predate the field, so absent must mean the default rather
    // than 0 — 0 is the explicit "never alert" switch, a different intent.
    expect(formFromProject(source).batteryAlertMonths).toBe(
      DEFAULT_BATTERY_ALERT_MONTHS
    );
  });

  it("keeps an explicit zero, which disables the alert", () => {
    // Must not be swallowed by a `||` fallback — that is the bug this pins.
    expect(
      formFromProject({ ...source, batteryAlertMonths: 0 }).batteryAlertMonths
    ).toBe(0);
  });

  it("keeps an explicit value", () => {
    expect(
      formFromProject({ ...source, batteryAlertMonths: 6 }).batteryAlertMonths
    ).toBe(6);
  });

  it("is dirty when changed", () => {
    expect(isDirty(base, { ...base, batteryAlertMonths: 6 })).toBe(true);
  });
});

describe("isDirty — timezone", () => {
  it("detects a changed timezone", () => {
    expect(isDirty(base, { ...base, timezone: "Europe/London" })).toBe(true);
  });
});

describe("normalizeNotifyChannels", () => {
  // Absent must read as telegram-only: the server treats undefined the same
  // way, so a legacy project's checkboxes show its real current behaviour.
  it("defaults to telegram when the field is absent", () => {
    expect(normalizeNotifyChannels(undefined)).toEqual(["telegram"]);
  });

  // An explicit empty selection is a real choice ("notify me nowhere") and
  // must survive a round-trip rather than snapping back to the default.
  it("keeps an explicit empty selection empty", () => {
    expect(normalizeNotifyChannels([])).toEqual([]);
  });

  it("passes through a valid pair in a stable order", () => {
    expect(normalizeNotifyChannels(["pushover", "telegram"])).toEqual([
      "telegram",
      "pushover",
    ]);
  });

  it("drops unknown channel names", () => {
    expect(normalizeNotifyChannels(["telegram", "sms"])).toEqual(["telegram"]);
  });

  it("de-duplicates repeated channels", () => {
    expect(normalizeNotifyChannels(["telegram", "telegram"])).toEqual(["telegram"]);
  });

  it("returns the default for a non-array value", () => {
    expect(normalizeNotifyChannels("telegram")).toEqual(["telegram"]);
  });
});

describe("notifyChannels in the form", () => {
  const source = {
    name: "Home",
    telegramBotToken: "tok",
    telegramChatId: "-100",
    sirenDurationSec: 120,
    timezone: "Asia/Jerusalem",
    serverActions: { sendTelegram: true, triggerSiren: false },
  };

  it("defaults to telegram for a project predating the field", () => {
    expect(formFromProject(source).notifyChannels).toEqual(["telegram"]);
  });

  it("reads an explicit channel list", () => {
    expect(
      formFromProject({ ...source, notifyChannels: ["telegram", "pushover"] })
        .notifyChannels
    ).toEqual(["telegram", "pushover"]);
  });

  it("preserves an explicitly empty list", () => {
    expect(
      formFromProject({ ...source, notifyChannels: [] }).notifyChannels
    ).toEqual([]);
  });

  it("is dirty when a channel is added or removed", () => {
    expect(
      isDirty(base, { ...base, notifyChannels: ["telegram", "pushover"] })
    ).toBe(true);
    expect(isDirty(base, { ...base, notifyChannels: [] })).toBe(true);
  });

  // Order is normalised on read, so a reordering cannot be a real edit — and
  // comparing arrays by reference would otherwise mark the form dirty on
  // every render.
  it("is not dirty when the same channels are listed", () => {
    expect(isDirty(base, { ...base, notifyChannels: ["telegram"] })).toBe(false);
  });
});
