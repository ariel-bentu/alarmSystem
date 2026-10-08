// Pure logic behind the Firmware card: whether to offer an update, what the
// device's progress means, and the exact command the device expects.
import type {
  FirmwareManifest,
  OtaStatus,
  RtdbBoot,
  RtdbOtaCommand,
  RtdbOtaState,
} from "@/types";
import type { TranslationKey } from "@/i18n/en";

export type FirmwareOffer =
  | { kind: "none" } // nothing published yet
  | { kind: "unknown" } // device has not reported a boot record
  | { kind: "unsupported" } // running firmware predates OTA — flash over USB once
  | { kind: "current" }
  | { kind: "available"; latest: FirmwareManifest };

/**
 * Versions are "YYYY.MM.DD-HHMM-sha" (fw_version.py), so plain string order is
 * build order. Only a STRICTLY newer release is offered: a device running a
 * newer local USB build must not be shown a "downgrade" as an update.
 */
export function firmwareOffer(
  boot: RtdbBoot | null,
  latest: FirmwareManifest | null
): FirmwareOffer {
  if (!latest) return { kind: "none" };
  if (!boot) return { kind: "unknown" };
  if (!boot.fw) return { kind: "unsupported" };
  return latest.version > boot.fw ? { kind: "available", latest } : { kind: "current" };
}

// How long the device may stay "in progress" before the UI stops believing
// it: a device that lost power mid-download never writes "failed".
const STALE_PROGRESS_MS = 15 * 60_000;
const IN_PROGRESS: OtaStatus[] = ["downloading", "rebooting"];

export function isOtaInProgress(state: RtdbOtaState | null, nowMs: number): boolean {
  if (!state || !IN_PROGRESS.includes(state.status)) return false;
  // `at` is 0-adjacent when the device had not synced NTP yet; trust those.
  if (state.at < 1e12) return true;
  return nowMs - state.at < STALE_PROGRESS_MS;
}

// How long the device will still act on a request. Covers a device that is
// briefly offline, without letting a forgotten command install days later.
export const OTA_REQUEST_TTL_SEC = 15 * 60;

export function buildOtaCommand(
  latest: FirmwareManifest,
  nowMs: number,
  nonce: number
): RtdbOtaCommand {
  return {
    n: nonce,
    version: latest.version,
    path: latest.path,
    md5: latest.md5,
    size: latest.size,
    until: Math.floor(nowMs / 1000) + OTA_REQUEST_TTL_SEC,
  };
}

/** A fresh uint32 nonce — the device acts on each value once (stored in NVS). */
export function newOtaNonce(): number {
  return crypto.getRandomValues(new Uint32Array(1))[0] || 1;
}

export function otaStatusKey(status: OtaStatus): TranslationKey {
  switch (status) {
    case "downloading":
      return "fw.status.downloading";
    case "rebooting":
      return "fw.status.rebooting";
    case "ok":
      return "fw.status.ok";
    case "failed":
      return "fw.status.failed";
    case "refused":
      return "fw.status.refused";
    case "rolled_back":
      return "fw.status.rolledBack";
  }
}

// Device refusal reasons (otaVerdictName in ota_command.h) → readable text.
export function refusalKey(detail: string | undefined): TranslationKey | null {
  switch (detail) {
    case "siren_active":
      return "fw.refused.siren";
    case "expired":
      return "fw.refused.expired";
    case "same_version":
      return "fw.refused.sameVersion";
    case "busy":
      return "fw.refused.busy";
    case "bad_request":
      return "fw.refused.badRequest";
    default:
      return null;
  }
}
