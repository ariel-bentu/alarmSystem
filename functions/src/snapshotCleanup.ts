// Task: snapshotCleanup — daily at noon, via doSchedule's table (see the row
// there). Not an onSchedule() of its own — same reason deadSensorCheck and
// eventCleanup aren't: Cloud Scheduler allows only 3 free jobs per BILLING
// ACCOUNT.
//
// Camera snapshots (onSnapshotUploaded.ts) land in Storage at
// "{projectId}/snapshots/{rfId}/{ts}/ch{N}.jpg" and are never deleted by that
// upload path — left to grow without bound the same way RTDB events did
// before eventCleanup.ts. This is that cleanup for Storage: per project,
// delete snapshot objects older than project.snapshotRetentionDays (default
// 14, matching the Project type's doc comment).
//
// Pure/IO split mirrors eventRetention.ts (pure policy) / eventCleanup.ts
// (RTDB IO): isExpired + pickExpiredFiles below are plain functions testable
// without any SDK; snapshotCleanup is the thin per-project Storage walk.
//
// Object age is read from the {ts} PATH SEGMENT, not Storage's own
// metadata.timeCreated. {ts} is the epoch-ms the device/NVR stamped at
// capture time — the same timestamp the Firestore timeline and the alarm
// correlation in onSnapshotUploaded.ts treat as authoritative — whereas
// timeCreated is merely when the upload happened to reach Storage (retries,
// backfills, or a clock-skewed capture device could all desync the two).
// Retention is about the AGE OF THE EVENT the photo documents, so the path
// segment is ground truth; metadata.timeCreated is used only as a fallback
// when a file under the snapshots/ prefix doesn't parse as the expected
// path shape, so a stray object still ages out eventually instead of living
// forever.

import { getStorage } from "firebase-admin/storage";
import { db } from "./admin";
import { Project } from "./types";
import { parseSnapshotPath } from "./snapshotPath";

/** Used when a project has no snapshotRetentionDays of its own. */
export const DEFAULT_SNAPSHOT_RETENTION_DAYS = 14;

const DAY_MS = 24 * 60 * 60 * 1000;

// Matches the bucket onSnapshotUploaded.ts pins explicitly, for the same
// reason given there: it sidesteps firebase-functions throwing at MODULE
// LOAD when FIREBASE_CONFIG is absent (which would make this file
// unimportable under vitest), and matches the one real bucket this project
// uses.
const SNAPSHOT_BUCKET = "alarm-system-100.firebasestorage.app";

/**
 * Whether an object timestamped `objectTimeMs` has aged out of a
 * `retentionDays`-long window as of `nowMs`.
 *
 * `>=` at the boundary (not `>`): an object exactly `retentionDays` old is
 * already outside the "events younger than this stay" promise, matching
 * how the brief phrases the boundary case (exactly now-14d -> expired).
 */
export function isExpired(
  objectTimeMs: number,
  nowMs: number,
  retentionDays: number
): boolean {
  return nowMs - objectTimeMs >= retentionDays * DAY_MS;
}

/** Minimal shape of a Storage file this module needs, so the selection
 *  logic below can be tested without a real @google-cloud/storage File. */
export interface SnapshotFile {
  name: string;
  timeCreatedMs: number | null;
}

/**
 * The subset of `files` that have expired, given `retentionDays` and
 * `nowMs`. Pure — no Storage IO — so it is testable on its own, the same
 * split expiredKeys (eventRetention.ts) gets for RTDB.
 *
 * Age comes from the {ts} path segment when the name parses as a snapshot
 * path; falling back to timeCreatedMs (and, failing that, treating the file
 * as NOT expired — see module doc comment on why "keep" is the safe
 * default for an undecidable age, the same stance expiredKeys takes for a
 * malformed RTDB key).
 */
export function pickExpiredFiles(
  files: SnapshotFile[],
  nowMs: number,
  retentionDays: number
): SnapshotFile[] {
  return files.filter((file) => {
    const parsed = parseSnapshotPath(stripProjectPrefix(file.name));
    const objectTimeMs = parsed?.ts ?? file.timeCreatedMs;
    if (objectTimeMs === null || objectTimeMs === undefined) return false;
    return isExpired(objectTimeMs, nowMs, retentionDays);
  });
}

// parseSnapshotPath expects "{projectId}/snapshots/...", which file.name
// already is (Storage object names are full paths) — this is a no-op kept
// as a named step so the intent reads clearly at the call site above.
function stripProjectPrefix(name: string): string {
  return name;
}

/**
 * Delete every expired snapshot object across every project. Best-effort
 * and isolated per project — one project's Storage/Firestore error must not
 * stop the others from being cleaned, the same stance deadSensorCheck takes
 * per-project and doSchedule takes per-task.
 */
export async function snapshotCleanup(): Promise<void> {
  const now = Date.now();
  const bucket = getStorage().bucket(SNAPSHOT_BUCKET);

  const projectsSnap = await db.collection("projects").get();

  for (const projectDoc of projectsSnap.docs) {
    const project = { id: projectDoc.id, ...projectDoc.data() } as Project;

    try {
      const retentionDays =
        project.snapshotRetentionDays ?? DEFAULT_SNAPSHOT_RETENTION_DAYS;

      const [gcsFiles] = await bucket.getFiles({
        prefix: `${project.id}/snapshots/`,
      });

      const files: SnapshotFile[] = gcsFiles.map((f) => ({
        name: f.name,
        timeCreatedMs: f.metadata?.timeCreated
          ? Date.parse(f.metadata.timeCreated)
          : null,
      }));

      const expired = pickExpiredFiles(files, now, retentionDays);
      if (expired.length === 0) continue;

      const gcsByName = new Map(gcsFiles.map((f) => [f.name, f]));
      await Promise.all(
        expired.map((f) => gcsByName.get(f.name)?.delete())
      );

      console.log(
        `snapshotCleanup: deleted ${expired.length} expired snapshot(s) from project=${project.id}`
      );
    } catch (err) {
      console.error(`snapshotCleanup failed for project=${project.id}`, err);
    }
  }
}
