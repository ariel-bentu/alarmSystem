// Firmware release manifest — shared shape between
// scripts/publishFirmware.ts (writes it) and the web UI (reads it; a copy of
// the interface lives in web/src/types). The device never reads Firestore:
// the web UI copies these fields into /{projectId}/commands/ota.
//
// Not used by any deployed function; it lives in src/ so the rules it
// encodes are unit-tested alongside everything else.

export const FIRMWARE_COLLECTION = "firmware";
export const FIRMWARE_LATEST_DOC = "latest";

// One app slot in default_16MB.csv. Mirrors kOtaMaxImageBytes in
// firmware/edge/device/src/ota_command.h — the device refuses anything larger.
export const MAX_IMAGE_BYTES = 0x640000;

export interface FirmwareManifest {
  version: string;
  path: string;
  size: number;
  md5: string;
  sha256: string;
  publishedAt: number; // epoch ms
  notes?: string;
}

// Same character set the device accepts (otaIsSafeVersion): the version is
// used as a Storage path segment and stored in NVS unescaped.
const SAFE_VERSION = /^[0-9A-Za-z._-]+$/;

export function firmwareObjectPath(version: string): string {
  return `firmware/${version}/firmware.bin`;
}

/** Why a build may not be published, or null if it may. */
export function publishBlocker(opts: {
  version: string;
  size: number;
  currentLatest: string | null;
  allowDirty: boolean;
  force: boolean;
}): string | null {
  const { version, size, currentLatest, allowDirty, force } = opts;
  if (!SAFE_VERSION.test(version)) return `unsafe version string "${version}"`;
  if (size <= 0) return "empty image";
  if (size > MAX_IMAGE_BYTES)
    return `image is ${size} bytes, larger than the ${MAX_IMAGE_BYTES}-byte app slot`;
  if (version.endsWith("-dirty") && !allowDirty)
    return "working tree has uncommitted changes (commit first, or pass --allow-dirty)";
  // The web UI only offers a version that sorts AFTER the running one, so an
  // older-or-equal publish would be invisible, and replacing a release under
  // the same name would change an image devices may already be running.
  if (currentLatest !== null && version <= currentLatest && !force)
    return `version ${version} does not sort after the published ${currentLatest} (pass --force to override)`;
  return null;
}
