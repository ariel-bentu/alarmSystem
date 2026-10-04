import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { notify, resolveChannels, NotifyMessage, APP_EVENTS_URL } from "./notify";
import type { Project } from "./types";

function project(over: Partial<Project> = {}): Project {
  // Only the fields notify() reads matter; the rest of Project is irrelevant
  // here, hence the cast.
  return {
    telegramBotToken: "bot",
    telegramChatId: "chat",
    ...over,
  } as Project;
}

function deps(secrets: Record<string, string> = {}) {
  return {
    db: {} as never,
    loadSecrets: vi.fn(async () => secrets),
    sendTelegramFn: vi.fn(async () => {}),
    sendPushoverFn: vi.fn(async () => {}),
  };
}

const bothSecrets = { pushoverToken: "ptok", pushoverUserKey: "pkey" };
const msg: NotifyMessage = { text: "hello", severity: "loud" };

describe("resolveChannels", () => {
  // The no-migration guarantee: every project predating the field keeps
  // behaving exactly as it did.
  it("defaults to telegram only when the field is absent", () => {
    expect(resolveChannels({})).toEqual(["telegram"]);
  });

  // An explicit empty array is a real choice ("notify me nowhere") and must
  // not be silently turned back into the default.
  it("returns nothing for an explicit empty array", () => {
    expect(resolveChannels({ notifyChannels: [] })).toEqual([]);
  });

  it("returns pushover only", () => {
    expect(resolveChannels({ notifyChannels: ["pushover"] })).toEqual(["pushover"]);
  });

  it("returns both when both are enabled", () => {
    expect(resolveChannels({ notifyChannels: ["telegram", "pushover"] })).toEqual([
      "telegram",
      "pushover",
    ]);
  });
});

describe("notify", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("sends Telegram only by default", async () => {
    const d = deps(bothSecrets);
    await notify("p", project(), msg, d);
    expect(d.sendTelegramFn).toHaveBeenCalledTimes(1);
    expect(d.sendPushoverFn).not.toHaveBeenCalled();
  });

  it("sends nothing when the channel list is empty", async () => {
    const d = deps(bothSecrets);
    await notify("p", project({ notifyChannels: [] }), msg, d);
    expect(d.sendTelegramFn).not.toHaveBeenCalled();
    expect(d.sendPushoverFn).not.toHaveBeenCalled();
  });

  it("sends both when both channels are enabled", async () => {
    const d = deps(bothSecrets);
    await notify("p", project({ notifyChannels: ["telegram", "pushover"] }), msg, d);
    expect(d.sendTelegramFn).toHaveBeenCalledTimes(1);
    expect(d.sendPushoverFn).toHaveBeenCalledTimes(1);
  });

  it("passes the message text and credentials through to Telegram", async () => {
    const d = deps();
    await notify("p", project(), { text: "<b>Boom</b>", severity: "loud" }, d);
    expect(d.sendTelegramFn).toHaveBeenCalledWith("bot", "chat", "<b>Boom</b>", false);
  });

  // The severity model is a faithful generalisation of the `silent` boolean
  // the code already used for arm/disarm notices.
  it("marks only notices silent on Telegram", async () => {
    const d = deps();
    await notify("p", project(), { text: "t", severity: "notice" }, d);
    expect(d.sendTelegramFn).toHaveBeenCalledWith("bot", "chat", "t", true);

    const d2 = deps();
    await notify("p", project(), { text: "t", severity: "alarm" }, d2);
    expect(d2.sendTelegramFn).toHaveBeenCalledWith("bot", "chat", "t", false);
  });

  it("passes severity and credentials through to Pushover", async () => {
    const d = deps(bothSecrets);
    await notify(
      "p",
      project({ notifyChannels: ["pushover"], pushoverRetrySec: 90, pushoverExpireSec: 600 }),
      { text: "t", severity: "alarm", title: "Alarm" },
      d
    );
    expect(d.sendPushoverFn).toHaveBeenCalledWith({
      token: "ptok",
      user: "pkey",
      message: "t",
      severity: "alarm",
      title: "Alarm",
      url: undefined,
      urlTitle: undefined,
      retrySec: 90,
      expireSec: 600,
    });
  });

  // The deep link: tapping the notification opens the installed PWA on the
  // events page, where the camera snapshots for the trigger are.
  it("attaches the PWA events link when link is set", async () => {
    const d = deps(bothSecrets);
    await notify(
      "p",
      project({ notifyChannels: ["pushover"] }),
      { text: "t", severity: "alarm", link: true },
      d
    );
    const call = d.sendPushoverFn.mock.calls[0][0];
    expect(call.url).toBe(APP_EVENTS_URL);
    expect(call.urlTitle).toBe("Open alarm system");
  });

  it("omits the link when not requested", async () => {
    const d = deps(bothSecrets);
    await notify("p", project({ notifyChannels: ["pushover"] }), msg, d);
    expect(d.sendPushoverFn.mock.calls[0][0].url).toBeUndefined();
  });

  // Telegram messages are unaffected: the link is a Pushover notification
  // action, and Telegram already renders bare URLs in the message body.
  it("does not alter the Telegram text when link is set", async () => {
    const d = deps();
    await notify("p", project(), { text: "t", severity: "alarm", link: true }, d);
    expect(d.sendTelegramFn).toHaveBeenCalledWith("bot", "chat", "t", false);
  });

  it("skips Telegram when its credentials are missing", async () => {
    const d = deps(bothSecrets);
    await notify(
      "p",
      project({ notifyChannels: ["telegram"], telegramBotToken: "", telegramChatId: "" }),
      msg,
      d
    );
    expect(d.sendTelegramFn).not.toHaveBeenCalled();
  });

  it("skips Pushover when its credentials are missing but still sends Telegram", async () => {
    const d = deps({}); // no secrets written yet
    await notify("p", project({ notifyChannels: ["telegram", "pushover"] }), msg, d);
    expect(d.sendPushoverFn).not.toHaveBeenCalled();
    expect(d.sendTelegramFn).toHaveBeenCalledTimes(1);
  });

  it("skips Pushover when only one of the two credentials is present", async () => {
    const d = deps({ pushoverToken: "ptok" });
    await notify("p", project({ notifyChannels: ["pushover"] }), msg, d);
    expect(d.sendPushoverFn).not.toHaveBeenCalled();
  });

  // Failure isolation is the core contract: one channel must never be able to
  // suppress the other.
  it("still sends Pushover when Telegram throws", async () => {
    const d = deps(bothSecrets);
    d.sendTelegramFn.mockRejectedValue(new Error("telegram down"));
    await notify("p", project({ notifyChannels: ["telegram", "pushover"] }), msg, d);
    expect(d.sendPushoverFn).toHaveBeenCalledTimes(1);
  });

  it("still sends Telegram when Pushover throws", async () => {
    const d = deps(bothSecrets);
    d.sendPushoverFn.mockRejectedValue(new Error("pushover down"));
    await notify("p", project({ notifyChannels: ["telegram", "pushover"] }), msg, d);
    expect(d.sendTelegramFn).toHaveBeenCalledTimes(1);
  });

  // Callers (deviceLiveness, deadSensorCheck) latch their alert markers only
  // after notify() resolves. If notify threw, that latch would be skipped and
  // retry behaviour would change silently.
  it("never rejects, even when both channels throw", async () => {
    const d = deps(bothSecrets);
    d.sendTelegramFn.mockRejectedValue(new Error("x"));
    d.sendPushoverFn.mockRejectedValue(new Error("y"));
    await expect(
      notify("p", project({ notifyChannels: ["telegram", "pushover"] }), msg, d)
    ).resolves.toBeUndefined();
  });

  it("never rejects when the secrets read throws", async () => {
    const d = deps();
    d.loadSecrets.mockRejectedValue(new Error("permission denied"));
    await expect(
      notify("p", project({ notifyChannels: ["telegram", "pushover"] }), msg, d)
    ).resolves.toBeUndefined();
    // Telegram is unaffected by a Pushover-credential failure.
    expect(d.sendTelegramFn).toHaveBeenCalledTimes(1);
  });

  // No point paying a Firestore read when no channel needs it.
  it("does not read secrets when Pushover is not enabled", async () => {
    const d = deps();
    await notify("p", project({ notifyChannels: ["telegram"] }), msg, d);
    expect(d.loadSecrets).not.toHaveBeenCalled();
  });
});
