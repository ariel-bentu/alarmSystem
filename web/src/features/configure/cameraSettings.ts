// Pure validation for the project-level NVR + AI-judge settings (CameraTab).
//
// capture+judge requires a real judge provider: the cloud's
// onSnapshotUploaded, when nvrMode is capture+judge but judgeProvider is
// "null"/unset, fails safe to a "breach" verdict on EVERY armed trigger —
// which spams "judge disabled" breach Telegrams. The form must refuse to
// save that combination rather than let the cloud discover it later.

import {
  normalizeCameraNames,
  type CameraNames,
} from "@/features/explore/cameraNames";

export type NvrMode = "off" | "capture" | "capture+judge";
export type JudgeProvider = "claude" | "null";

export interface NvrSettingsInput {
  cameraNames?: unknown;
  nvrMode?: unknown;
  nvrHost?: unknown;
  nvrPort?: unknown;
  nvrUser?: unknown;
  nvrPassword?: unknown;
  captureCooldownSec?: unknown;
  snapshotRetentionDays?: unknown;
  judgeProvider?: unknown;
  judgeModel?: unknown;
  judgePrompt?: unknown;
}

export interface NvrSettingsValue {
  // Always present, even when empty: a missing key would make clearing the
  // last remaining name impossible, since updateDoc reads absent as
  // "leave unchanged".
  cameraNames: CameraNames;
  nvrMode: NvrMode;
  nvrHost?: string;
  nvrPort?: number;
  nvrUser?: string;
  nvrPassword?: string;
  captureCooldownSec: number;
  snapshotRetentionDays: number;
  judgeProvider?: JudgeProvider;
  judgeModel?: string;
  judgePrompt?: string;
}

export type NvrSettingsResult =
  | { ok: true; value: NvrSettingsValue }
  | { ok: false; error: string };

const NVR_MODES: NvrMode[] = ["off", "capture", "capture+judge"];
const JUDGE_PROVIDERS: JudgeProvider[] = ["claude", "null"];

export function validateNvrSettings(
  input: NvrSettingsInput
): NvrSettingsResult {
  const nvrMode = input.nvrMode;
  if (typeof nvrMode !== "string" || !NVR_MODES.includes(nvrMode as NvrMode)) {
    return { ok: false, error: "Select a valid camera mode." };
  }

  const nvrPort = input.nvrPort;
  if (
    typeof nvrPort !== "number" ||
    !Number.isInteger(nvrPort) ||
    nvrPort < 1 ||
    nvrPort > 65535
  ) {
    return { ok: false, error: "Port must be between 1 and 65535." };
  }

  const captureCooldownSec = input.captureCooldownSec;
  if (
    typeof captureCooldownSec !== "number" ||
    !Number.isFinite(captureCooldownSec) ||
    captureCooldownSec < 5
  ) {
    return { ok: false, error: "Capture cooldown must be at least 5 seconds." };
  }

  const snapshotRetentionDays = input.snapshotRetentionDays;
  if (
    typeof snapshotRetentionDays !== "number" ||
    !Number.isFinite(snapshotRetentionDays) ||
    snapshotRetentionDays < 1
  ) {
    return { ok: false, error: "Snapshot retention must be at least 1 day." };
  }

  const judgeProviderRaw = input.judgeProvider;
  const judgeProvider =
    typeof judgeProviderRaw === "string" &&
    JUDGE_PROVIDERS.includes(judgeProviderRaw as JudgeProvider)
      ? (judgeProviderRaw as JudgeProvider)
      : undefined;

  if (nvrMode === "capture+judge" && (!judgeProvider || judgeProvider === "null")) {
    return {
      ok: false,
      error: "Enable an AI judge provider to use capture+judge mode.",
    };
  }

  const nvrHost =
    typeof input.nvrHost === "string" && input.nvrHost.trim() !== ""
      ? input.nvrHost
      : undefined;
  const nvrUser =
    typeof input.nvrUser === "string" && input.nvrUser.trim() !== ""
      ? input.nvrUser
      : undefined;
  const nvrPassword =
    typeof input.nvrPassword === "string" && input.nvrPassword !== ""
      ? input.nvrPassword
      : undefined;
  const judgeModel =
    typeof input.judgeModel === "string" && input.judgeModel.trim() !== ""
      ? input.judgeModel
      : undefined;
  const judgePrompt =
    typeof input.judgePrompt === "string" && input.judgePrompt.trim() !== ""
      ? input.judgePrompt
      : undefined;

  // Firestore's updateDoc REJECTS any field whose value is `undefined` (unlike
  // a missing key). nvrMode/nvrPort/captureCooldownSec/snapshotRetentionDays are
  // guaranteed defined here (validation returned ok:false above otherwise); the
  // rest are optional and must be OMITTED when blank, not set to undefined.
  const value: NvrSettingsValue = {
    nvrMode: nvrMode as NvrMode,
    nvrPort,
    captureCooldownSec,
    snapshotRetentionDays,
    // Unlike the optional strings below, this is always written: see the
    // field's note on why an empty map must not become a missing key.
    cameraNames: normalizeCameraNames(input.cameraNames),
  };
  if (nvrHost !== undefined) value.nvrHost = nvrHost;
  if (nvrUser !== undefined) value.nvrUser = nvrUser;
  if (nvrPassword !== undefined) value.nvrPassword = nvrPassword;
  if (judgeProvider !== undefined) value.judgeProvider = judgeProvider;
  if (judgeModel !== undefined) value.judgeModel = judgeModel;
  if (judgePrompt !== undefined) value.judgePrompt = judgePrompt;

  return { ok: true, value };
}
