import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  isExpired,
  pickExpiredFiles,
  SnapshotFile,
  DEFAULT_SNAPSHOT_RETENTION_DAYS,
} from "./snapshotCleanup";

const DAY = 86400_000;

describe("isExpired", () => {
  it("expires objects older than retention", () => {
    const now = 100 * DAY;
    expect(isExpired(now - 15 * DAY, now, 14)).toBe(true);
    expect(isExpired(now - 13 * DAY, now, 14)).toBe(false);
  });

  it("expires exactly at the boundary (>=)", () => {
    const now = 100 * DAY;
    expect(isExpired(now - 14 * DAY, now, 14)).toBe(true);
  });

  it("never expires an object from the future", () => {
    const now = 100 * DAY;
    expect(isExpired(now + DAY, now, 14)).toBe(false);
  });
});

describe("pickExpiredFiles", () => {
  const PROJECT = "proj1";
  const now = 100 * DAY;

  function pathFor(rfId: string, ts: number, ch = 1): string {
    return `${PROJECT}/snapshots/${rfId}/${ts}/ch${ch}.jpg`;
  }

  it("selects files whose {ts} path segment has expired", () => {
    const files: SnapshotFile[] = [
      { name: pathFor("rf1", now - 15 * DAY), timeCreatedMs: null },
      { name: pathFor("rf2", now - 13 * DAY), timeCreatedMs: null },
    ];
    const expired = pickExpiredFiles(files, now, 14);
    expect(expired.map((f) => f.name)).toEqual([pathFor("rf1", now - 15 * DAY)]);
  });

  it("keeps non-expired files", () => {
    const files: SnapshotFile[] = [
      { name: pathFor("rf1", now - 1 * DAY), timeCreatedMs: null },
    ];
    expect(pickExpiredFiles(files, now, 14)).toEqual([]);
  });

  it("applies the default retention (14 days) when caller passes it through", () => {
    const files: SnapshotFile[] = [
      { name: pathFor("rf1", now - 15 * DAY), timeCreatedMs: null },
      { name: pathFor("rf2", now - 10 * DAY), timeCreatedMs: null },
    ];
    const expired = pickExpiredFiles(files, now, DEFAULT_SNAPSHOT_RETENTION_DAYS);
    expect(expired).toHaveLength(1);
    expect(expired[0].name).toContain("rf1");
  });

  it("falls back to timeCreatedMs when the name does not parse as a snapshot path", () => {
    const files: SnapshotFile[] = [
      { name: `${PROJECT}/snapshots/weird-garbage`, timeCreatedMs: now - 15 * DAY },
      { name: `${PROJECT}/snapshots/also-weird`, timeCreatedMs: now - 1 * DAY },
    ];
    const expired = pickExpiredFiles(files, now, 14);
    expect(expired).toEqual([files[0]]);
  });

  it("keeps a file with no decidable age (unparsable name, no metadata) rather than guessing", () => {
    const files: SnapshotFile[] = [
      { name: `${PROJECT}/snapshots/mystery`, timeCreatedMs: null },
    ];
    expect(pickExpiredFiles(files, now, 14)).toEqual([]);
  });

  it("returns nothing for an empty file list", () => {
    expect(pickExpiredFiles([], now, 14)).toEqual([]);
  });
});

// --- snapshotCleanup IO orchestration ---
//
// Mocks firebase-admin/storage's getStorage() and ./admin's db, the same
// style onSnapshotUploaded.test.ts uses for its own Firestore/Storage
// surface: just enough of the real API (bucket().getFiles(), file.delete())
// for the orchestration logic, not a full emulator.

interface FakeFile {
  name: string;
  metadata: { timeCreated?: string };
  delete: ReturnType<typeof vi.fn>;
}

function makeFakeFile(name: string, timeCreated?: string): FakeFile {
  return {
    name,
    metadata: timeCreated ? { timeCreated } : {},
    delete: vi.fn(async () => {}),
  };
}

const getFilesMock = vi.fn();
const bucketMock = vi.fn(() => ({ getFiles: getFilesMock }));

vi.mock("firebase-admin/storage", () => ({
  getStorage: () => ({ bucket: bucketMock }),
}));

interface FakeProjectDoc {
  id: string;
  data: () => Record<string, unknown>;
}

const projectDocs: FakeProjectDoc[] = [];
const getMock = vi.fn(async () => ({ docs: projectDocs }));

vi.mock("./admin", () => ({
  db: {
    collection: () => ({ get: getMock }),
  },
}));

// Imported AFTER the mocks above so snapshotCleanup picks up the mocked
// ./admin and firebase-admin/storage rather than the real modules.
import { snapshotCleanup } from "./snapshotCleanup";

describe("snapshotCleanup", () => {
  const now = 100 * DAY;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    projectDocs.length = 0;
    getFilesMock.mockReset();
    bucketMock.mockClear();
  });

  function setProjects(docs: FakeProjectDoc[]) {
    projectDocs.push(...docs);
  }

  it("deletes expired files and keeps non-expired ones, per project", async () => {
    setProjects([{ id: "proj1", data: () => ({}) }]);
    const expiredFile = makeFakeFile(
      `proj1/snapshots/rf1/${now - 15 * DAY}/ch1.jpg`
    );
    const freshFile = makeFakeFile(
      `proj1/snapshots/rf1/${now - 1 * DAY}/ch1.jpg`
    );
    getFilesMock.mockResolvedValueOnce([[expiredFile, freshFile]]);

    await snapshotCleanup();

    expect(expiredFile.delete).toHaveBeenCalledTimes(1);
    expect(freshFile.delete).not.toHaveBeenCalled();
    expect(bucketMock).toHaveBeenCalledWith("alarm-system-100.firebasestorage.app");
    expect(getFilesMock).toHaveBeenCalledWith({ prefix: "proj1/snapshots/" });
  });

  it("defaults retention to 14 days when snapshotRetentionDays is absent", async () => {
    setProjects([{ id: "proj1", data: () => ({}) }]);
    const justOverDefault = makeFakeFile(
      `proj1/snapshots/rf1/${now - 15 * DAY}/ch1.jpg`
    );
    const underDefault = makeFakeFile(
      `proj1/snapshots/rf1/${now - 10 * DAY}/ch1.jpg`
    );
    getFilesMock.mockResolvedValueOnce([[justOverDefault, underDefault]]);

    await snapshotCleanup();

    expect(justOverDefault.delete).toHaveBeenCalledTimes(1);
    expect(underDefault.delete).not.toHaveBeenCalled();
  });

  it("honors a project's own snapshotRetentionDays over the default", async () => {
    setProjects([{ id: "proj1", data: () => ({ snapshotRetentionDays: 5 }) }]);
    const sixDaysOld = makeFakeFile(
      `proj1/snapshots/rf1/${now - 6 * DAY}/ch1.jpg`
    );
    getFilesMock.mockResolvedValueOnce([[sixDaysOld]]);

    await snapshotCleanup();

    expect(sixDaysOld.delete).toHaveBeenCalledTimes(1);
  });

  it("isolates a per-project failure so other projects still get cleaned", async () => {
    setProjects([
      { id: "broken", data: () => ({}) },
      { id: "ok", data: () => ({}) },
    ]);
    const okExpired = makeFakeFile(`ok/snapshots/rf1/${now - 15 * DAY}/ch1.jpg`);

    getFilesMock
      .mockRejectedValueOnce(new Error("storage outage"))
      .mockResolvedValueOnce([[okExpired]]);

    await expect(snapshotCleanup()).resolves.toBeUndefined();

    expect(okExpired.delete).toHaveBeenCalledTimes(1);
  });

  it("does nothing when there are no projects", async () => {
    setProjects([]);
    await snapshotCleanup();
    expect(getFilesMock).not.toHaveBeenCalled();
  });
});
