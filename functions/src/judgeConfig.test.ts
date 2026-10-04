import { describe, it, expect, vi } from "vitest";
import { loadJudgeKeys, JUDGE_CONFIG_PATH } from "./judgeConfig";

// Minimal Firestore stand-in: only doc().get() is exercised.
function fakeDb(doc: { exists: boolean; data?: Record<string, unknown> } | Error) {
  const get = vi.fn(async () => {
    if (doc instanceof Error) throw doc;
    return { exists: doc.exists, data: () => doc.data };
  });
  const docFn = vi.fn(() => ({ get }));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { db: { doc: docFn } as any, docFn, get };
}

describe("loadJudgeKeys", () => {
  it("reads from the server-only config/judge path", async () => {
    const { db, docFn } = fakeDb({ exists: true, data: {} });
    await loadJudgeKeys(db);
    expect(docFn).toHaveBeenCalledWith(JUDGE_CONFIG_PATH);
    expect(JUDGE_CONFIG_PATH).toBe("config/judge");
  });

  it("returns both keys when both are set", async () => {
    const { db } = fakeDb({
      exists: true,
      data: { anthropicApiKey: "sk-ant", geminiApiKey: "AQ-gem" },
    });
    expect(await loadJudgeKeys(db)).toEqual({ anthropic: "sk-ant", gemini: "AQ-gem" });
  });

  it("returns only the key that is present", async () => {
    const { db } = fakeDb({ exists: true, data: { geminiApiKey: "AQ-gem" } });
    expect(await loadJudgeKeys(db)).toEqual({ gemini: "AQ-gem" });
  });

  it("returns an empty set when the doc does not exist", async () => {
    const { db } = fakeDb({ exists: false });
    expect(await loadJudgeKeys(db)).toEqual({});
  });

  it("ignores blank and non-string keys rather than passing them on", async () => {
    const { db } = fakeDb({
      exists: true,
      data: { anthropicApiKey: "   ", geminiApiKey: 42 },
    });
    expect(await loadJudgeKeys(db)).toEqual({});
  });

  // A thrown read must not take down the whole snapshot handler. The caller
  // turns a missing key into NullJudge, which fails safe to "breach".
  it("swallows a Firestore read failure and returns an empty set", async () => {
    const { db } = fakeDb(new Error("permission denied"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await loadJudgeKeys(db)).toEqual({});
  });
});
