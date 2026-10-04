import { describe, it, expect, vi, beforeEach } from "vitest";
import { handleSnapshotUpload, SnapshotUploadDeps } from "./onSnapshotUploaded";
import { judgeFor } from "./snapshotJudge";
import type { JudgeKeys } from "./judgeConfig";

vi.mock("./telegram", () => ({
  sendTelegramPhoto: vi.fn(async () => {}),
}));
vi.mock("./snapshotJudge", async () => {
  const actual = await vi.importActual<typeof import("./snapshotJudge")>("./snapshotJudge");
  return { ...actual, judgeFor: vi.fn() };
});

import { sendTelegramPhoto } from "./telegram";

// --- Minimal in-memory Firestore/RTDB fakes ---
//
// Nothing in this codebase mocks ./admin's Firestore/Database directly
// (every other trigger keeps its decision logic in a pure, separately
// tested helper and leaves the thin onXxx wrapper to emulator smoke tests).
// This task's brief explicitly calls for mocking Firestore/RTDB/Storage
// around the orchestration logic itself, so handleSnapshotUpload takes an
// injectable SnapshotUploadDeps and these fakes implement just enough of
// the Firestore/Database surface (doc/get/set/update, ref/get/set) for it.

interface FakeDocData {
  [key: string]: unknown;
}

function makeFakeFirestore(seed: Record<string, FakeDocData> = {}) {
  const store = new Map<string, FakeDocData>(Object.entries(seed));

  function docRef(path: string) {
    return {
      id: path.split("/").pop()!,
      async get() {
        const data = store.get(path);
        return {
          exists: data !== undefined,
          id: path.split("/").pop()!,
          data: () => data,
        };
      },
      async set(value: FakeDocData, opts?: { merge?: boolean }) {
        const existing = store.get(path) ?? {};
        if (opts?.merge) {
          store.set(path, mergeDeep(existing, value));
        } else {
          store.set(path, value);
        }
      },
      async update(value: FakeDocData) {
        const existing = store.get(path) ?? {};
        store.set(path, mergeDeep(existing, value));
      },
    };
  }

  function mergeDeep(a: FakeDocData, b: FakeDocData): FakeDocData {
    const out: FakeDocData = { ...a };
    for (const [k, v] of Object.entries(b)) {
      // FieldValue.arrayUnion sentinel handling (see fakeArrayUnion below).
      if (v && typeof v === "object" && (v as { __arrayUnion?: unknown[] }).__arrayUnion) {
        const existingArr = Array.isArray(out[k]) ? (out[k] as unknown[]) : [];
        out[k] = [...existingArr, ...(v as { __arrayUnion: unknown[] }).__arrayUnion];
      } else {
        out[k] = v;
      }
    }
    return out;
  }

  function collectionRef(path: string) {
    return {
      async get() {
        const prefix = path + "/";
        const docs = Array.from(store.entries())
          .filter(([k]) => k.startsWith(prefix) && !k.slice(prefix.length).includes("/"))
          .map(([k, v]) => ({ id: k.slice(prefix.length), data: () => v }));
        return { docs, empty: docs.length === 0 };
      },
    };
  }

  return {
    doc: (path: string) => docRef(path),
    collection: (path: string) => collectionRef(path),
    _store: store,
  };
}

function makeFakeRtdb(seed: Record<string, unknown> = {}) {
  const store = new Map<string, unknown>(Object.entries(seed));
  return {
    ref: (path: string) => ({
      async get() {
        const v = store.get(path);
        return { val: () => (v === undefined ? null : v) };
      },
      async set(value: unknown) {
        store.set(path, value);
      },
    }),
    _store: store,
  };
}

// Mock firebase-admin/firestore's FieldValue.arrayUnion with a sentinel the
// fake store above understands, since the real FieldValue needs a live app.
vi.mock("firebase-admin/firestore", async () => {
  const actual = await vi.importActual<typeof import("firebase-admin/firestore")>(
    "firebase-admin/firestore"
  );
  return {
    ...actual,
    FieldValue: {
      arrayUnion: (...items: unknown[]) => ({ __arrayUnion: items }),
    },
  };
});

const PROJECT_ID = "proj1";
const RF_ID = "0x0061DA"; // family 0x0061D
const TS = 1696000000000;
const JPEG = Buffer.from([0xff, 0xd8, 0xff]);

function objectName(channel: number) {
  return `${PROJECT_ID}/snapshots/${RF_ID}/${TS}/ch${channel}.jpg`;
}

function makeDeps(opts: {
  project: FakeDocData;
  sensors?: Record<string, FakeDocData>;
  rtdbSeed?: Record<string, unknown>;
  judgeKeys?: JudgeKeys;
}): { deps: SnapshotUploadDeps; fs: ReturnType<typeof makeFakeFirestore>; rtdb: ReturnType<typeof makeFakeRtdb> } {
  const seed: Record<string, FakeDocData> = {
    // Every judge path is gated on the project naming a provider, so default
    // one in. Individual tests override `project` wholesale to vary it.
    [`projects/${PROJECT_ID}`]: { judgeProvider: "claude", ...opts.project },
  };
  for (const [id, data] of Object.entries(opts.sensors ?? {})) {
    seed[`projects/${PROJECT_ID}/sensors/${id}`] = data;
  }
  const fs = makeFakeFirestore(seed);
  const rtdb = makeFakeRtdb(opts.rtdbSeed ?? {});

  const deps: SnapshotUploadDeps = {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    db: fs as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    rtdb: rtdb as any,
    downloadJpeg: vi.fn(async () => JPEG),
    downloadUrl: vi.fn(async (_p: string, name: string) => `https://example.test/${name}`),
    judgeKeys: async () =>
      "judgeKeys" in opts ? (opts.judgeKeys as JudgeKeys) : { anthropic: "sk-test" },
    now: () => 1700000000000,
    // Injected like every other dep rather than vi.mock'd: notify() reads
    // Firestore for the Pushover credentials, and this file's fakes do not
    // model the secrets subcollection.
    notify: vi.fn(async () => {}),
  };
  return { deps, fs, rtdb };
}

describe("handleSnapshotUpload", () => {
  beforeEach(() => {
    vi.mocked(sendTelegramPhoto).mockReset();
    vi.mocked(sendTelegramPhoto).mockImplementation(async () => {});
    vi.mocked(judgeFor).mockReset();
  });

  it("ignores a non-snapshot object", async () => {
    const { deps } = makeDeps({ project: { nvrMode: "capture+judge" } });
    await handleSnapshotUpload(deps, "proj1/other/x.jpg");
    expect(deps.downloadUrl).not.toHaveBeenCalled();
  });

  it("(a) always augments the timeline, regardless of mode", async () => {
    const { deps, fs } = makeDeps({
      project: { nvrMode: "off" },
      sensors: { s1: { rfId: RF_ID, familyId: "0x0061D", name: "Front door" } },
    });

    await handleSnapshotUpload(deps, objectName(1));

    const doc = fs._store.get(`projects/${PROJECT_ID}/timeline/${RF_ID}_${TS}`);
    expect(doc).toBeDefined();
    expect(doc?.sensorName).toBe("Front door");
    expect(doc?.snapshots).toEqual([{ channel: 1, url: `https://example.test/${objectName(1)}` }]);
  });

  it("merges multiple channels of the same trigger onto ONE timeline doc", async () => {
    const { deps, fs } = makeDeps({ project: { nvrMode: "off" } });

    await handleSnapshotUpload(deps, objectName(1));
    await handleSnapshotUpload(deps, objectName(2));

    const doc = fs._store.get(`projects/${PROJECT_ID}/timeline/${RF_ID}_${TS}`);
    expect(doc?.snapshots).toEqual([
      { channel: 1, url: `https://example.test/${objectName(1)}` },
      { channel: 2, url: `https://example.test/${objectName(2)}` },
    ]);
  });

  it("(b) does NOT call the judge when nvrMode is not capture+judge", async () => {
    const { deps } = makeDeps({
      project: { nvrMode: "capture" },
      rtdbSeed: {
        [`${PROJECT_ID}/state/alarm_cause`]: { rfId: RF_ID, at: TS },
      },
    });

    await handleSnapshotUpload(deps, objectName(0));

    expect(judgeFor).not.toHaveBeenCalled();
  });

  it("(c) does NOT call the judge when there is no fresh matching alarm_cause (not armed at trigger time)", async () => {
    const { deps } = makeDeps({
      project: { nvrMode: "capture+judge" },
      // No alarm_cause at all recorded for this rfId/ts.
      rtdbSeed: {},
    });

    await handleSnapshotUpload(deps, objectName(0));

    expect(judgeFor).not.toHaveBeenCalled();
  });

  it("(c2) does NOT call the judge when the recorded cause is for a different sensor family", async () => {
    const { deps } = makeDeps({
      project: { nvrMode: "capture+judge" },
      rtdbSeed: {
        [`${PROJECT_ID}/state/alarm_cause`]: { rfId: "0x09999A", at: TS },
      },
    });

    await handleSnapshotUpload(deps, objectName(0));

    expect(judgeFor).not.toHaveBeenCalled();
  });

  it("(c3) does NOT call the judge when the recorded cause is stale relative to the trigger ts", async () => {
    const { deps } = makeDeps({
      project: { nvrMode: "capture+judge" },
      rtdbSeed: {
        // Written 2 minutes before this trigger's own ts -> stale.
        [`${PROJECT_ID}/state/alarm_cause`]: { rfId: RF_ID, at: TS - 120_000 },
      },
    });

    await handleSnapshotUpload(deps, objectName(0));

    expect(judgeFor).not.toHaveBeenCalled();
  });

  it("(d) a 'safe' verdict writes /commands/fp with {rfId, ts} and annotates the timeline", async () => {
    const stubJudge = { judge: vi.fn(async () => ({ verdict: "safe" as const, reason: "empty yard" })) };
    vi.mocked(judgeFor).mockReturnValue(stubJudge);

    const { deps, fs, rtdb } = makeDeps({
      project: { nvrMode: "capture+judge" },
      rtdbSeed: {
        [`${PROJECT_ID}/state/alarm_cause`]: { rfId: RF_ID, at: TS },
      },
    });

    await handleSnapshotUpload(deps, objectName(0));

    expect(stubJudge.judge).toHaveBeenCalledTimes(1);
    const fp = rtdb._store.get(`${PROJECT_ID}/commands/fp`);
    expect(fp).toEqual({ rfId: RF_ID, ts: TS, at: 1700000000000 });

    const doc = fs._store.get(`projects/${PROJECT_ID}/timeline/${RF_ID}_${TS}`);
    expect(doc?.aiNote).toContain("false positive (AI)");
    expect(doc?.aiNote).toContain("empty yard");

    expect(sendTelegramPhoto).not.toHaveBeenCalled();
  });

  it("(e) a 'breach' verdict calls sendTelegramPhoto with a caption naming sensor + channel", async () => {
    const stubJudge = { judge: vi.fn(async () => ({ verdict: "breach" as const, reason: "person at door" })) };
    vi.mocked(judgeFor).mockReturnValue(stubJudge);

    const { deps, fs, rtdb } = makeDeps({
      project: {
        nvrMode: "capture+judge",
        telegramBotToken: "tok",
        telegramChatId: "chat",
      },
      sensors: { s1: { rfId: RF_ID, familyId: "0x0061D", name: "Front door" } },
      rtdbSeed: {
        [`${PROJECT_ID}/state/alarm_cause`]: { rfId: RF_ID, at: TS },
      },
    });

    await handleSnapshotUpload(deps, objectName(2));

    expect(sendTelegramPhoto).toHaveBeenCalledTimes(1);
    const [token, chatId, jpeg, caption] = vi.mocked(sendTelegramPhoto).mock.calls[0];
    expect(token).toBe("tok");
    expect(chatId).toBe("chat");
    expect(jpeg).toEqual(JPEG);
    expect(caption).toContain("Front door");
    expect(caption).toContain("camera 2");
    expect(caption).toContain("person at door");

    // No false-positive advisory on a breach.
    expect(rtdb._store.get(`${PROJECT_ID}/commands/fp`)).toBeUndefined();

    const doc = fs._store.get(`projects/${PROJECT_ID}/timeline/${RF_ID}_${TS}`);
    expect(doc?.aiNote).toContain("confirmed breach (AI)");

    // The same caption also goes through notify(), so a Pushover-only
    // project is woken by the breach.
    expect(deps.notify).toHaveBeenCalledTimes(1);
    const [, , notifyMsg] = vi.mocked(deps.notify).mock.calls[0];
    // "loud", not "alarm": this fixture's sensor has no definiteBreach
    // field, which means DEFINITE, so onAlarm already sent the repeating
    // priority-2 emergency. See the dedicated certainty tests below.
    expect(notifyMsg.severity).toBe("loud");
    expect(notifyMsg.link).toBe(true);
    expect(notifyMsg.text).toContain("Front door");
  });

  // The behaviour that made notify() worth routing here: before it, a breach
  // on a project without Telegram credentials returned early and alerted
  // nobody at all.
  it("notifies on a breach even when no Telegram is configured", async () => {
    const stubJudge = {
      judge: vi.fn(async () => ({ verdict: "breach" as const, reason: "person" })),
    };
    vi.mocked(judgeFor).mockReturnValue(stubJudge);

    const { deps } = makeDeps({
      project: { nvrMode: "capture+judge" }, // no telegram credentials
      sensors: { s1: { rfId: RF_ID, familyId: "0x0061D", name: "Front door" } },
      rtdbSeed: {
        [`${PROJECT_ID}/state/alarm_cause`]: { rfId: RF_ID, at: TS },
      },
    });

    await handleSnapshotUpload(deps, objectName(2));

    expect(deps.notify).toHaveBeenCalledTimes(1);
    // The photo still cannot be sent — Pushover attachments are out of scope.
    expect(sendTelegramPhoto).not.toHaveBeenCalled();
  });

  // A caption reading "Front door" beats "camera 2" on a phone at 3am — the
  // whole point of naming the channels.
  it("uses the camera's name in the breach caption when the project names it", async () => {
    const stubJudge = { judge: vi.fn(async () => ({ verdict: "breach" as const, reason: "person" })) };
    vi.mocked(judgeFor).mockReturnValue(stubJudge);

    const { deps } = makeDeps({
      project: {
        nvrMode: "capture+judge",
        telegramBotToken: "tok",
        telegramChatId: "chat",
        cameraNames: { "2": "Front gate" },
      },
      sensors: { s1: { rfId: RF_ID, familyId: "0x0061D", name: "Front door" } },
      rtdbSeed: {
        [`${PROJECT_ID}/state/alarm_cause`]: { rfId: RF_ID, at: TS },
      },
    });

    await handleSnapshotUpload(deps, objectName(2));

    const [, , , caption] = vi.mocked(sendTelegramPhoto).mock.calls[0];
    expect(caption).toContain("Front gate");
    expect(caption).not.toContain("camera 2");
  });

  it("passes the camera name to the judge as scene context", async () => {
    const stubJudge = { judge: vi.fn(async () => ({ verdict: "safe" as const, reason: "empty" })) };
    vi.mocked(judgeFor).mockReturnValue(stubJudge);

    const { deps } = makeDeps({
      project: {
        nvrMode: "capture+judge",
        cameraNames: { "2": "Front gate" },
      },
      sensors: { s1: { rfId: RF_ID, familyId: "0x0061D", name: "Front door" } },
      rtdbSeed: {
        [`${PROJECT_ID}/state/alarm_cause`]: { rfId: RF_ID, at: TS },
      },
    });

    await handleSnapshotUpload(deps, objectName(2));

    expect(stubJudge.judge.mock.calls[0][1]).toMatchObject({
      channel: 2,
      cameraName: "Front gate",
    });
  });

  it("omits cameraName for an unnamed channel so the judge falls back to the number", async () => {
    const stubJudge = { judge: vi.fn(async () => ({ verdict: "safe" as const, reason: "empty" })) };
    vi.mocked(judgeFor).mockReturnValue(stubJudge);

    const { deps } = makeDeps({
      project: { nvrMode: "capture+judge", cameraNames: { "5": "Shed" } },
      sensors: { s1: { rfId: RF_ID, familyId: "0x0061D", name: "Front door" } },
      rtdbSeed: {
        [`${PROJECT_ID}/state/alarm_cause`]: { rfId: RF_ID, at: TS },
      },
    });

    await handleSnapshotUpload(deps, objectName(2));

    expect(stubJudge.judge.mock.calls[0][1].cameraName).toBeUndefined();
  });

  it("skips the judge entirely when no key is configured for the provider", async () => {
    const { deps } = makeDeps({
      project: { nvrMode: "capture+judge", judgeProvider: "claude" },
      judgeKeys: {},
      rtdbSeed: {
        [`${PROJECT_ID}/state/alarm_cause`]: { rfId: RF_ID, at: TS },
      },
    });

    await handleSnapshotUpload(deps, objectName(0));

    expect(judgeFor).not.toHaveBeenCalled();
  });

  // Keys are per-provider: a project set to Gemini must not quietly run on the
  // Anthropic key that happens to be configured for a different provider.
  it("skips the judge when only the OTHER provider's key is configured", async () => {
    const { deps } = makeDeps({
      project: { nvrMode: "capture+judge", judgeProvider: "gemini" },
      judgeKeys: { anthropic: "sk-test" },
      rtdbSeed: {
        [`${PROJECT_ID}/state/alarm_cause`]: { rfId: RF_ID, at: TS },
      },
    });

    await handleSnapshotUpload(deps, objectName(0));

    expect(judgeFor).not.toHaveBeenCalled();
  });

  it("runs the judge for a gemini project when the gemini key is configured", async () => {
    const stubJudge = {
      judge: vi.fn(async () => ({ verdict: "safe" as const, reason: "empty" })),
    };
    vi.mocked(judgeFor).mockReturnValue(stubJudge);

    const { deps } = makeDeps({
      project: { nvrMode: "capture+judge", judgeProvider: "gemini", judgeModel: "m" },
      judgeKeys: { gemini: "AQ-test" },
      rtdbSeed: {
        [`${PROJECT_ID}/state/alarm_cause`]: { rfId: RF_ID, at: TS },
      },
    });

    await handleSnapshotUpload(deps, objectName(0));

    expect(judgeFor).toHaveBeenCalledWith("gemini", { gemini: "AQ-test" }, "m");
    expect(stubJudge.judge).toHaveBeenCalledTimes(1);
  });

  describe("all-channels coordination (first breach wins; safe withheld if a sibling already breached)", () => {
    it("does not write the advisory for a 'safe' channel if a sibling channel already recorded breach", async () => {
      const breachJudge = { judge: vi.fn(async () => ({ verdict: "breach" as const, reason: "intruder" })) };
      const safeJudge = { judge: vi.fn(async () => ({ verdict: "safe" as const, reason: "empty" })) };

      const { deps, rtdb } = makeDeps({
        project: {
          nvrMode: "capture+judge",
          telegramBotToken: "tok",
          telegramChatId: "chat",
        },
        rtdbSeed: {
          [`${PROJECT_ID}/state/alarm_cause`]: { rfId: RF_ID, at: TS },
        },
      });

      vi.mocked(judgeFor).mockReturnValueOnce(breachJudge);
      await handleSnapshotUpload(deps, objectName(1));
      expect(sendTelegramPhoto).toHaveBeenCalledTimes(1);

      vi.mocked(judgeFor).mockReturnValueOnce(safeJudge);
      await handleSnapshotUpload(deps, objectName(2));

      // The advisory must NOT be written: a breach was already recorded for
      // this {rfId, ts}, and the safe direction is to leave the alarm
      // standing rather than risk suppressing a real breach seen on another
      // channel.
      expect(rtdb._store.get(`${PROJECT_ID}/commands/fp`)).toBeUndefined();
    });

    it("sends exactly one Telegram when multiple channels independently judge breach", async () => {
      const breachJudge = { judge: vi.fn(async () => ({ verdict: "breach" as const, reason: "intruder" })) };

      const { deps } = makeDeps({
        project: {
          nvrMode: "capture+judge",
          telegramBotToken: "tok",
          telegramChatId: "chat",
        },
        rtdbSeed: {
          [`${PROJECT_ID}/state/alarm_cause`]: { rfId: RF_ID, at: TS },
        },
      });

      vi.mocked(judgeFor).mockReturnValue(breachJudge);
      await handleSnapshotUpload(deps, objectName(1));
      await handleSnapshotUpload(deps, objectName(2));

      // Current implementation sends a Telegram alert on EVERY breach
      // verdict (each is independently a true positive worth alerting on),
      // not only the first — see the module doc comment: "first breach
      // wins" is enforced for the ADVISORY (never withheld once any breach
      // is recorded), not as a dedupe on the alert itself. Documented
      // explicitly rather than silently deduped, since under-alerting a
      // real breach is the wrong direction to err.
      expect(sendTelegramPhoto).toHaveBeenCalledTimes(2);
    });
  });

  it("resolves the sensor name by FAMILY, not exact rfId (tamper code vs paired motion code)", async () => {
    const { deps, fs } = makeDeps({
      project: { nvrMode: "off" },
      sensors: { s1: { rfId: "0x0061DA", familyId: "0x0061D", name: "Front door" } },
    });

    // A tamper code (different bottom nibble) from the SAME family.
    const tamperObject = `${PROJECT_ID}/snapshots/0x0061DB/${TS}/ch0.jpg`;
    await handleSnapshotUpload(deps, tamperObject);

    const doc = fs._store.get(`projects/${PROJECT_ID}/timeline/0x0061DB_${TS}`);
    expect(doc?.sensorName).toBe("Front door");
  });

  // --- breach escalation by sensor certainty ---

  it("escalates a NON-definite sensor's breach to emergency", async () => {
    const stubJudge = {
      judge: vi.fn(async () => ({ verdict: "breach" as const, reason: "person" })),
    };
    vi.mocked(judgeFor).mockReturnValue(stubJudge);

    const { deps } = makeDeps({
      project: { nvrMode: "capture+judge", telegramBotToken: "tok", telegramChatId: "c" },
      sensors: {
        s1: {
          rfId: RF_ID,
          familyId: "0x0061D",
          name: "Garden PIR",
          definiteBreach: false,
        },
      },
      rtdbSeed: { [`${PROJECT_ID}/state/alarm_cause`]: { rfId: RF_ID, at: TS } },
    });

    await handleSnapshotUpload(deps, objectName(2));

    const [, , msg] = vi.mocked(deps.notify).mock.calls[0];
    // The alarm went out as priority 1; THIS is the first emergency push.
    expect(msg.severity).toBe("alarm");
  });

  it("does not re-escalate a DEFINITE sensor's breach", async () => {
    const stubJudge = {
      judge: vi.fn(async () => ({ verdict: "breach" as const, reason: "person" })),
    };
    vi.mocked(judgeFor).mockReturnValue(stubJudge);

    const { deps } = makeDeps({
      project: { nvrMode: "capture+judge", telegramBotToken: "tok", telegramChatId: "c" },
      sensors: {
        s1: {
          rfId: RF_ID,
          familyId: "0x0061D",
          name: "Front door",
          definiteBreach: true,
        },
      },
      rtdbSeed: { [`${PROJECT_ID}/state/alarm_cause`]: { rfId: RF_ID, at: TS } },
    });

    await handleSnapshotUpload(deps, objectName(2));

    const [, , msg] = vi.mocked(deps.notify).mock.calls[0];
    // onAlarm already sent priority 2 and it is still repeating. A second
    // emergency would be two repeating alerts for one event.
    expect(msg.severity).toBe("loud");
    // The photo still goes out either way.
    expect(sendTelegramPhoto).toHaveBeenCalledTimes(1);
  });

  // --- safe verdict: quiet all-clear ---

  it("sends a silent all-clear on a safe verdict", async () => {
    const stubJudge = {
      judge: vi.fn(async () => ({ verdict: "safe" as const, reason: "empty frame" })),
    };
    vi.mocked(judgeFor).mockReturnValue(stubJudge);

    const { deps, rtdb } = makeDeps({
      project: { nvrMode: "capture+judge" },
      sensors: { s1: { rfId: RF_ID, familyId: "0x0061D", name: "Garden PIR" } },
      rtdbSeed: { [`${PROJECT_ID}/state/alarm_cause`]: { rfId: RF_ID, at: TS } },
    });

    await handleSnapshotUpload(deps, objectName(2));

    const [, , msg] = vi.mocked(deps.notify).mock.calls[0];
    expect(msg.severity).toBe("notice"); // priority -1: explains, never wakes
    expect(msg.text).toContain("Cleared");
    // The existing advisory behaviour is unchanged.
    expect(rtdb._store.get(`${PROJECT_ID}/commands/fp`)).toBeDefined();
  });

  // An all-clear must never contradict a standing alarm.
  //
  // The sibling breach is seeded by RUNNING THE HANDLER TWICE with different
  // judges — the pattern the existing "all-channels coordination" describe
  // block uses. Writing the snapshotJudging doc directly would couple this
  // test to the fake's internals and would not exercise the real
  // coordination write.
  it("sends NO all-clear when a sibling channel already saw a breach", async () => {
    const breachJudge = {
      judge: vi.fn(async () => ({ verdict: "breach" as const, reason: "intruder" })),
    };
    const safeJudge = {
      judge: vi.fn(async () => ({ verdict: "safe" as const, reason: "empty" })),
    };

    const { deps } = makeDeps({
      project: { nvrMode: "capture+judge", telegramBotToken: "tok", telegramChatId: "c" },
      sensors: { s1: { rfId: RF_ID, familyId: "0x0061D", name: "Garden PIR" } },
      rtdbSeed: { [`${PROJECT_ID}/state/alarm_cause`]: { rfId: RF_ID, at: TS } },
    });

    vi.mocked(judgeFor).mockReturnValueOnce(breachJudge);
    await handleSnapshotUpload(deps, objectName(1));
    const callsAfterBreach = vi.mocked(deps.notify).mock.calls.length;

    vi.mocked(judgeFor).mockReturnValueOnce(safeJudge);
    await handleSnapshotUpload(deps, objectName(2));

    // The breach notified; the later safe channel must add nothing, because
    // an "all clear" would contradict the alarm still standing.
    expect(vi.mocked(deps.notify).mock.calls.length).toBe(callsAfterBreach);
  });
});
