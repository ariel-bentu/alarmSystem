import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  pushoverPriority,
  pushoverBody,
  sendPushover,
  PUSHOVER_API_URL,
  DEFAULT_RETRY_SEC,
  DEFAULT_EXPIRE_SEC,
} from "./pushover";

describe("pushoverPriority", () => {
  // Only "alarm" may break through a muted ringer. Pushover applies Apple's
  // Critical Alerts entitlement to priority 1 as well as 2, so "loud" must
  // NOT be 1 — at 1 it overrode silence too, leaving the two tiers
  // indistinguishable by ear.
  it("maps alarm to emergency priority 2", () => {
    expect(pushoverPriority("alarm")).toBe(2);
  });

  // THE assertion that keeps non-definite alerts from overriding silence.
  // Raising this to 1 would hand a maybe-a-cat motion trigger the same
  // mute-breaking power as a confirmed break-in.
  it("maps loud to NORMAL priority 0, which respects mute and DND", () => {
    expect(pushoverPriority("loud")).toBe(0);
  });

  it("maps notice to low priority -1", () => {
    expect(pushoverPriority("notice")).toBe(-1);
  });

  // Only priority 2 gets the Critical Alerts treatment now, so it is the
  // only tier that can wake someone whose phone is silenced.
  it("gives only alarm a mute-overriding priority", () => {
    expect(pushoverPriority("alarm")).toBeGreaterThan(1);
    expect(pushoverPriority("loud")).toBeLessThanOrEqual(0);
    expect(pushoverPriority("notice")).toBeLessThanOrEqual(0);
  });
});

describe("pushoverBody", () => {
  const base = { token: "t", user: "u", message: "<b>Hi</b>", severity: "loud" as const };

  it("includes the required credentials and message", () => {
    const b = pushoverBody(base);
    expect(b.get("token")).toBe("t");
    expect(b.get("user")).toBe("u");
    expect(b.get("message")).toBe("<b>Hi</b>");
  });

  it("enables the HTML subset so shared <b> formatters render", () => {
    expect(pushoverBody(base).get("html")).toBe("1");
  });

  it("omits retry and expire for non-emergency priorities", () => {
    const b = pushoverBody(base);
    expect(b.get("retry")).toBeNull();
    expect(b.get("expire")).toBeNull();
  });

  // Pushover REJECTS priority 2 without both parameters. This is the failure
  // mode worth pinning: an alarm that silently fails to send.
  it("always carries retry and expire for priority 2", () => {
    const b = pushoverBody({ ...base, severity: "alarm" });
    expect(b.get("priority")).toBe("2");
    expect(b.get("retry")).toBe(String(DEFAULT_RETRY_SEC));
    expect(b.get("expire")).toBe(String(DEFAULT_EXPIRE_SEC));
  });

  it("honours per-project retry and expire overrides", () => {
    const b = pushoverBody({ ...base, severity: "alarm", retrySec: 120, expireSec: 7200 });
    expect(b.get("retry")).toBe("120");
    expect(b.get("expire")).toBe("7200");
  });

  it("floors retry at the API minimum of 30s", () => {
    const b = pushoverBody({ ...base, severity: "alarm", retrySec: 5 });
    expect(b.get("retry")).toBe("30");
  });

  it("caps expire at the API maximum of 10800s", () => {
    const b = pushoverBody({ ...base, severity: "alarm", expireSec: 99999 });
    expect(b.get("expire")).toBe("10800");
  });

  it("includes a title when given and omits it otherwise", () => {
    expect(pushoverBody({ ...base, title: "Alarm" }).get("title")).toBe("Alarm");
    expect(pushoverBody(base).get("title")).toBeNull();
  });

  // The PWA deep link: Pushover renders url/url_title as a tappable action,
  // and because the web app's manifest has scope "/" and display
  // "standalone", an in-scope https link opens the INSTALLED app rather than
  // Safari.
  it("includes the supplementary url and its title when given", () => {
    const b = pushoverBody({
      ...base,
      url: "https://alarm-system-100.web.app/explore",
      urlTitle: "Open alarm system",
    });
    expect(b.get("url")).toBe("https://alarm-system-100.web.app/explore");
    expect(b.get("url_title")).toBe("Open alarm system");
  });

  it("omits url_title when no url is given", () => {
    const b = pushoverBody({ ...base, urlTitle: "Open alarm system" });
    expect(b.get("url")).toBeNull();
    expect(b.get("url_title")).toBeNull();
  });

  // A short default tone re-sent every `retry` seconds is why an emergency
  // alert can fail to feel like a repeating alarm; the long sounds fix that.
  it("includes the sound when set", () => {
    expect(pushoverBody({ ...base, sound: "persistent" }).get("sound")).toBe(
      "persistent"
    );
  });

  // Omitted, not blank: Pushover falls back to the user's own default tone,
  // and sending "" would be a request to play nothing.
  it("omits the sound when unset or empty", () => {
    expect(pushoverBody(base).get("sound")).toBeNull();
    expect(pushoverBody({ ...base, sound: "" }).get("sound")).toBeNull();
  });
});

describe("sendPushover", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("POSTs form-encoded to the Pushover messages endpoint", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue({ ok: true, status: 200, text: async () => "" } as Response);

    await sendPushover({ token: "t", user: "u", message: "m", severity: "loud" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(PUSHOVER_API_URL);
    expect(init?.method).toBe("POST");
    expect((init?.headers as Record<string, string>)["Content-Type"]).toBe(
      "application/x-www-form-urlencoded"
    );
    expect(String(init?.body)).toContain("token=t");
  });

  // Same contract as sendTelegram: log, never throw. Callers latch alert
  // markers after a send, so an escaping exception would change retry
  // behaviour.
  it("logs and swallows a non-OK response", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: false,
      status: 400,
      text: async () => "application token is invalid",
    } as Response);

    await expect(
      sendPushover({ token: "t", user: "u", message: "m", severity: "alarm" })
    ).resolves.toBeUndefined();
    expect(console.error).toHaveBeenCalled();
  });

  it("logs and swallows a network rejection", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("ECONNRESET"));

    await expect(
      sendPushover({ token: "t", user: "u", message: "m", severity: "loud" })
    ).resolves.toBeUndefined();
    expect(console.error).toHaveBeenCalled();
  });
});
