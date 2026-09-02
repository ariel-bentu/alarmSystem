// Classify a device boot reason for display.
//
// Why this exists: a device that crashes and reboots looks EXACTLY like one
// that never left — it reconnects, resumes heartbeating, and the UI goes
// green again. The only trace is state/boot.reason. A board was once found
// dead after 9h16m uptime with no record of why, and reconstructing even the
// time of death took heartbeat arithmetic against RTDB event keys.
//
// So: "power_on" and "external" are how a human restarts a device and are not
// worth reporting. Everything else means it went down on its own.

import type { RtdbBoot } from "@/types";
import type { TranslationKey } from "@/i18n/en";

export type BootSeverity = "normal" | "unexpected";

/** Reasons that indicate a deliberate, human-initiated (re)start. */
const EXPECTED_REASONS = new Set(["power_on", "external", "sw_restart"]);

export function bootSeverity(reason: string | undefined): BootSeverity {
  if (!reason) return "normal";
  return EXPECTED_REASONS.has(reason) ? "normal" : "unexpected";
}

/**
 * i18n key describing a reset reason. Returns a key rather than text so the
 * banner translates like everything else; callers pass the result to t().
 * An unrecognised reason falls back to a key that interpolates {reason}, so
 * a new firmware value still shows something useful instead of blank.
 */
export function bootReasonKey(reason: string | undefined): TranslationKey {
  switch (reason) {
    case "power_on":
      return "ops.bootPowerOn";
    case "external":
      return "ops.bootExternal";
    case "sw_restart":
      return "ops.bootSwRestart";
    case "panic":
      return "ops.bootPanic";
    case "twdt":
    case "int_wdt":
    case "other_wdt":
      return "ops.bootWatchdog";
    case "brownout":
      return "ops.bootBrownout";
    case "deepsleep":
      return "ops.bootDeepSleep";
    default:
      return "ops.bootUnknown";
  }
}

/**
 * True when a boot record is recent enough to be worth surfacing. An old
 * crash is history, not a live alert — without this the banner would be
 * permanent, since the node persists until the next boot overwrites it.
 *
 * `at` may be 0-adjacent when the device booted before NTP synced; such a
 * record is deliberately NOT shown as recent, since its timestamp cannot be
 * compared meaningfully.
 */
export function isRecentBoot(
  boot: RtdbBoot | null | undefined,
  now: number,
  windowMs: number
): boolean {
  if (!boot || typeof boot.at !== "number") return false;
  // Pre-NTP timestamps land near the epoch; treat them as undatable.
  if (boot.at < 100_000_000_000) return false;
  const age = now - boot.at;
  return age >= 0 && age <= windowMs;
}
