// Ported from features/setup/settingsForm.test.ts when the Settings page was
// split across the Configure tabs. Every case that covered a field now on the
// Notifications tab is preserved; the cases for fields that became
// instant-save controls (channels, sound, the two checkboxes) kept their
// read/normalise coverage and lost only their isDirty assertions, since those
// fields are no longer form state.
import { describe, it, expect } from "vitest";
import {
  type NotifyForm,
  formFromProject,
  isDirty,
  normalizeNotifyChannels,
  credsFromSecrets,
  credsDirty,
  credsComplete,
  normalizeDevices,
  PUSHOVER_SOUNDS_LONG,
  PUSHOVER_SOUNDS_SHORT,
  JUDGE_WAIT_OFF,
  JUDGE_WAIT_MAX_SEC,
} from "./notifySettings";
import { DEFAULT_BATTERY_ALERT_MONTHS } from "./batteryAge";

const base: NotifyForm = {
  botToken: "tok",
  chatId: "-100",
  pushoverRetrySec: 60,
  pushoverExpireSec: 3600,
  batteryAlertMonths: DEFAULT_BATTERY_ALERT_MONTHS,
  judgeWaitSec: JUDGE_WAIT_OFF,
};

const source = {
  telegramBotToken: "tok",
  telegramChatId: "-100",
};

describe("isDirty", () => {
  it("is false when nothing has changed", () => {
    expect(isDirty(base, { ...base })).toBe(false);
  });

  it("detects a changed text field", () => {
    expect(isDirty(base, { ...base, botToken: "other" })).toBe(true);
  });

  it("detects a changed number field", () => {
    expect(isDirty(base, { ...base, pushoverRetrySec: 30 })).toBe(true);
    expect(isDirty(base, { ...base, pushoverExpireSec: 600 })).toBe(true);
    expect(isDirty(base, { ...base, batteryAlertMonths: 6 })).toBe(true);
    expect(isDirty(base, { ...base, judgeWaitSec: 20 })).toBe(true);
  });

  it("is false again once a field is changed back", () => {
    const edited = { ...base, botToken: "other" };
    expect(isDirty(base, edited)).toBe(true);
    expect(isDirty(base, { ...edited, botToken: "tok" })).toBe(false);
  });

  // Trailing whitespace is stripped on save, so " tok " would otherwise
  // enable Save and then save a value identical to what was already stored.
  it("ignores leading/trailing whitespace in text fields", () => {
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
    expect(
      formFromProject({
        telegramBotToken: "tok",
        telegramChatId: "-100",
        pushoverRetrySec: 30,
        pushoverExpireSec: 600,
        batteryAlertMonths: 6,
      })
    ).toEqual({
      botToken: "tok",
      chatId: "-100",
      pushoverRetrySec: 30,
      pushoverExpireSec: 600,
      batteryAlertMonths: 6,
      judgeWaitSec: JUDGE_WAIT_OFF,
    });
  });
});

describe("judgeWaitSec", () => {
  // OFF by default, deliberately: deferring changes when the owner is woken
  // for a real alarm, so it must be opted into rather than inherited by every
  // existing project on deploy.
  it("defaults to off when the project has no value", () => {
    expect(formFromProject(source).judgeWaitSec).toBe(JUDGE_WAIT_OFF);
    expect(JUDGE_WAIT_OFF).toBe(0);
  });

  it("reads an explicit value", () => {
    expect(formFromProject({ ...source, judgeWaitSec: 20 }).judgeWaitSec).toBe(20);
  });

  // Above the server's own 45s fallback the sweeper fires first, so a larger
  // value cannot do anything. The cap documents that rather than inviting it.
  it("caps at the server's fallback deadline", () => {
    expect(JUDGE_WAIT_MAX_SEC).toBe(45);
  });
});

describe("batteryAlertMonths", () => {
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
    expect(normalizeNotifyChannels(["telegram", "telegram"])).toEqual([
      "telegram",
    ]);
  });

  it("returns the default for a non-array value", () => {
    expect(normalizeNotifyChannels("telegram")).toEqual(["telegram"]);
  });
});

describe("Pushover retry settings", () => {
  it("defaults retry and expire to the API-sane values", () => {
    const f = formFromProject(source);
    expect(f.pushoverRetrySec).toBe(60);
    expect(f.pushoverExpireSec).toBe(3600);
  });

  it("reads explicit values", () => {
    const f = formFromProject({
      ...source,
      pushoverRetrySec: 30,
      pushoverExpireSec: 600,
    });
    expect(f.pushoverRetrySec).toBe(30);
    expect(f.pushoverExpireSec).toBe(600);
  });

  // `??` not `||`: the server clamps these, so a stored 0 must survive to the
  // input and read as visibly wrong rather than be silently replaced.
  it("keeps an explicit zero rather than substituting the default", () => {
    expect(formFromProject({ ...source, pushoverRetrySec: 0 }).pushoverRetrySec).toBe(0);
  });
});

describe("Pushover credentials", () => {
  it("reads both halves from the secrets doc", () => {
    expect(
      credsFromSecrets({ pushoverToken: "app", pushoverUserKey: "usr" })
    ).toEqual({ appToken: "app", userKey: "usr", devices: "" });
  });

  // An absent doc (or an absent field) must map to "", not undefined: these
  // feed controlled <input> values, and undefined makes React drop to an
  // uncontrolled input that silently ignores later updates.
  it("maps an empty secrets doc to empty strings", () => {
    expect(credsFromSecrets({})).toEqual({ appToken: "", userKey: "", devices: "" });
  });

  it("maps a partially filled doc without inventing the other half", () => {
    expect(credsFromSecrets({ pushoverToken: "app" })).toEqual({
      appToken: "app",
      userKey: "",
      devices: "",
    });
  });

  describe("credsDirty", () => {
    const saved = { appToken: "app", userKey: "usr", devices: "iphone" };

    it("is false when nothing changed", () => {
      expect(credsDirty(saved, { ...saved })).toBe(false);
    });

    it("detects a change to either half", () => {
      expect(credsDirty(saved, { ...saved, appToken: "other" })).toBe(true);
      expect(credsDirty(saved, { ...saved, userKey: "other" })).toBe(true);
    });

    // Save trims, so a trailing space must not enable the button and then
    // write a value identical to the stored one.
    it("ignores surrounding whitespace", () => {
      expect(
        credsDirty(saved, { appToken: " app ", userKey: "usr ", devices: " iphone, " })
      ).toBe(false);
    });

    it("detects a change to the device list", () => {
      expect(credsDirty(saved, { ...saved, devices: "iphone,ipad" })).toBe(true);
      expect(credsDirty(saved, { ...saved, devices: "" })).toBe(true);
    });

    it("detects clearing a credential", () => {
      expect(credsDirty(saved, { ...saved, appToken: "" })).toBe(true);
    });
  });

  describe("credsComplete", () => {
    // Pushover needs the pair: notify() checks both before dispatching, so
    // one alone is not "configured" and must not set the mirror flag.
    it("requires both halves", () => {
      expect(credsComplete({ appToken: "app", userKey: "usr", devices: "" })).toBe(true);
      expect(credsComplete({ appToken: "app", userKey: "", devices: "" })).toBe(false);
      expect(credsComplete({ appToken: "", userKey: "usr", devices: "" })).toBe(false);
      expect(credsComplete({ appToken: "", userKey: "", devices: "" })).toBe(false);
    });

    it("treats whitespace-only as absent", () => {
      expect(credsComplete({ appToken: "   ", userKey: "usr", devices: "" })).toBe(false);
    });
  });
});

describe("Pushover sounds", () => {
  // The five long sounds are the point of the picker; a short sound re-sent
  // every retry interval is what made an emergency alert feel wrong.
  it("lists the long sounds separately from the short ones", () => {
    expect(PUSHOVER_SOUNDS_LONG).toContain("persistent");
    expect(PUSHOVER_SOUNDS_LONG).toContain("echo");
    expect(PUSHOVER_SOUNDS_SHORT).toContain("siren");
  });

  it("shares no sound between the two lists", () => {
    // A duplicate would render twice in the picker, under both optgroups.
    const overlap = PUSHOVER_SOUNDS_LONG.filter((s) =>
      (PUSHOVER_SOUNDS_SHORT as readonly string[]).includes(s)
    );
    expect(overlap).toEqual([]);
  });
});

describe("normalizeDevices", () => {
  it("joins names with bare commas, dropping blanks and spaces", () => {
    expect(normalizeDevices(" iphone, ipad ,,watch ")).toBe("iphone,ipad,watch");
  });
  it("is empty (= all devices) for blank input", () => {
    expect(normalizeDevices("  , ")).toBe("");
  });
});
