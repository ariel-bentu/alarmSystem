import { describe, it, expect } from "vitest";
import { Timestamp } from "firebase-admin/firestore";
import {
  formatSensorAlert,
  formatAlarm,
  formatArmState,
  formatDeadSensor,
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

  describe("formatDeadSensor", () => {
    it("formats dead sensor alert", () => {
      expect(formatDeadSensor("Front door", 24)).toBe("💤 Front door has not reported in 24h");
    });
    it("handles fractional hours", () => {
      expect(formatDeadSensor("PIR", 48)).toBe("💤 PIR has not reported in 48h");
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
