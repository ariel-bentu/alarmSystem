/**
 * Pure parsing of a Storage object name written by the device/NVR capture
 * path: "{projectId}/snapshots/{rfId}/{ts}/ch{N}.jpg".
 *
 * Kept free of any SDK so onSnapshotUploaded's routing logic is unit
 * testable without mocking Storage.
 */

export interface SnapshotPath {
  projectId: string;
  rfId: string;
  ts: number;
  channel: number;
}

// ts is epoch-ms and can exceed 2^31 (the 32-bit epoch-seconds wrap in 2038
// is already in the past for epoch-ms values well before then) — parsed as
// a JS `number`, safe up to 2^53, which epoch-ms is nowhere near.
const SNAPSHOT_PATH_RE =
  /^([^/]+)\/snapshots\/([^/]+)\/(\d+)\/ch(\d+)\.jpg$/;

export function parseSnapshotPath(objectName: string): SnapshotPath | null {
  const match = SNAPSHOT_PATH_RE.exec(objectName);
  if (!match) return null;

  const [, projectId, rfId, tsStr, channelStr] = match;
  const ts = Number(tsStr);
  const channel = Number(channelStr);
  if (!Number.isSafeInteger(ts) || !Number.isInteger(channel)) return null;

  return { projectId, rfId, ts, channel };
}
