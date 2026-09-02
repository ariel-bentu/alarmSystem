import { describe, it, expect, afterEach } from "vitest";
import { Timestamp } from "firebase-admin/firestore";
import {
  sendTelegram,
  formatSensorAlert,
  formatAlarm,
  formatArmState,
  formatArmStateBySource,
  formatDeadSensor,
  formatDeviceOffline,
  formatDeviceBackOnline,
  formatStatus,
  StatusInfo,
} from "./telegram";

describe("telegram formatters", () => {
  describe("formatSensorAlert", () => {
    it("formats trigger", () => {
      expect(formatSensorAlert("Front door", "trigger")).toBe("📡 Front door triggered");
    });
    it("formats tamper", () => {
      expect(formatSensorAlert("Garden PIR", "tamper")).toBe("⚠️ Garden PIR tampered");
    });
    it("formats battery_low", () => {
      expect(formatSensorAlert("Back door", "battery_low")).toBe("🔋 Back door battery low");
    });
    it("formats unknown event type with fallback", () => {
      expect(formatSensorAlert("Sensor", "weird")).toBe("📡 Sensor: weird");
    });
  });

  describe("formatAlarm", () => {
    it("formats alarm message", () => {
      expect(formatAlarm("Living room PIR")).toBe("🚨 Alarm triggered — Living room PIR");
    });
  });

  describe("formatArmState", () => {
    it("formats armed", () => {
      expect(formatArmState(true)).toBe("🔒 System armed");
    });
    it("formats disarmed", () => {
      expect(formatArmState(false)).toBe("🔓 System disarmed");
    });
  });

  describe("formatArmStateBySource", () => {
    it("names the remote as the disarm source", () => {
      expect(formatArmStateBySource(false, "remote")).toBe("🔓 Disarmed by remote");
    });
    it("names the local web UI as the disarm source", () => {
      expect(formatArmStateBySource(false, "local")).toBe(
        "🔓 Disarmed from local web UI"
      );
    });
    it("names the remote when arming", () => {
      expect(formatArmStateBySource(true, "remote")).toBe("🔒 Armed by remote");
    });
    it("falls back to a generic message for an unknown source", () => {
      expect(formatArmStateBySource(false, null)).toBe("🔓 Device disarmed");
      expect(formatArmStateBySource(true, "wat")).toBe("🔒 Device armed");
    });
  });

  describe("formatDeadSensor", () => {
    it("formats dead sensor alert", () => {
      expect(formatDeadSensor("Front door", 24)).toBe("💤 Front door has not reported in 24h");
    });
    it("handles fractional hours", () => {
      expect(formatDeadSensor("PIR", 48)).toBe("💤 PIR has not reported in 48h");
    });
  });

  describe("formatDeviceOffline", () => {
    it("calls out the armed case explicitly", () => {
      // Armed + offline is the dangerous combination: nothing is watching.
      expect(formatDeviceOffline("6m", true)).toBe(
        "📵 Alarm device offline while ARMED — no heartbeat for 6m"
      );
    });

    it("omits the arm state when disarmed", () => {
      expect(formatDeviceOffline("3h", false)).toBe(
        "📵 Alarm device offline — no heartbeat for 3h"
      );
    });
  });

  describe("formatDeviceBackOnline", () => {
    it("reports how long the outage lasted", () => {
      expect(formatDeviceBackOnline("1d 4h")).toBe(
        "✅ Alarm device back online — was offline for 1d 4h"
      );
    });
  });

  describe("formatStatus", () => {
    it("formats full status", () => {
      const info: StatusInfo = {
        serverArmed: true,
        deviceArmed: false,
        sirenActive: false,
        activeDeviceProfile: "Away",
        activeServerProfile: "At Home",
        sensors: [
          { name: "Front door", lastSeen: Timestamp.fromMillis(1692345600000), batteryStatus: "ok" },
          { name: "Back window", lastSeen: null, batteryStatus: "low" },
        ],
      };
      const result = formatStatus(info);

      expect(result).toContain("Server armed: YES");
      expect(result).toContain("Device armed: NO");
      expect(result).toContain("Siren active: NO");
      expect(result).toContain("Device profile: Away");
      expect(result).toContain("Server profile: At Home");
      expect(result).toContain("• Front door");
      expect(result).toContain("• Back window — last: never 🔋LOW");
    });

    it("handles null profiles", () => {
      const info: StatusInfo = {
        serverArmed: false,
        deviceArmed: false,
        sirenActive: false,
        activeDeviceProfile: null,
        activeServerProfile: null,
        sensors: [],
      };
      const result = formatStatus(info);
      expect(result).toContain("Device profile: none");
      expect(result).toContain("Server profile: none");
    });
  });
});

describe("sendTelegram silent flag", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("omits disable_notification by default", async () => {
    let captured: Record<string, unknown> = {};
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      captured = JSON.parse(init.body as string);
      return { ok: true } as Response;
    }) as typeof fetch;

    await sendTelegram("tok", "chat", "hello");
    expect(captured.disable_notification).toBeUndefined();
  });

  it("sets disable_notification when silent", async () => {
    let captured: Record<string, unknown> = {};
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      captured = JSON.parse(init.body as string);
      return { ok: true } as Response;
    }) as typeof fetch;

    await sendTelegram("tok", "chat", "hello", true);
    expect(captured.disable_notification).toBe(true);
  });
});
