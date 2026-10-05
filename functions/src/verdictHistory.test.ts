import { describe, it, expect } from "vitest";
import { priorVerdictsFromDocs, judgingDocId, parseJudgingDocId } from "./verdictHistory";

const RF = "0x009BFA";
const TS = 1_791_209_562_000;

describe("judgingDocId / parseJudgingDocId", () => {
  it("round-trips", () => {
    const id = judgingDocId(RF, TS);
    expect(id).toBe(`${RF}_${TS}`);
    expect(parseJudgingDocId(id)).toEqual({ rfId: RF, ts: TS });
  });

  it("rejects a malformed id rather than guessing", () => {
    expect(parseJudgingDocId("nonsense")).toBe(null);
    expect(parseJudgingDocId("0x009BFA_notanumber")).toBe(null);
    expect(parseJudgingDocId("")).toBe(null);
  });

  // The rfId itself contains no underscore, but splitting on the LAST one is
  // still the safe reading — a future id shape with a prefix would otherwise
  // silently mis-parse.
  it("splits on the last underscore", () => {
    expect(parseJudgingDocId(`a_b_${TS}`)).toEqual({ rfId: "a_b", ts: TS });
  });
});

describe("priorVerdictsFromDocs", () => {
  // Flattens sibling coordination docs for the SAME rfId into a verdict list
  // reusableVerdict() can scan. Each doc holds several channels; the trigger
  // ts comes from the doc id, not from the per-channel `at` (which is when the
  // verdict was WRITTEN, a different clock).
  it("flattens channels across docs, taking ts from the doc id", () => {
    const got = priorVerdictsFromDocs([
      {
        id: judgingDocId(RF, TS),
        channels: {
          "1": { verdict: "safe", reason: "empty", at: TS + 5_000 },
          "2": { verdict: "breach", reason: "person", at: TS + 6_000 },
        },
      },
    ]);
    expect(got).toEqual([
      { ts: TS, verdict: "safe", reason: "empty" },
      { ts: TS, verdict: "breach", reason: "person" },
    ]);
  });

  it("skips docs with an unparseable id", () => {
    expect(
      priorVerdictsFromDocs([
        { id: "garbage", channels: { "1": { verdict: "safe", reason: "r", at: 1 } } },
      ])
    ).toEqual([]);
  });

  it("skips docs with no channels", () => {
    expect(priorVerdictsFromDocs([{ id: judgingDocId(RF, TS) }])).toEqual([]);
  });

  it("drops channel entries with an unrecognised verdict", () => {
    expect(
      priorVerdictsFromDocs([
        {
          id: judgingDocId(RF, TS),
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          channels: { "1": { verdict: "maybe" as any, reason: "r", at: 1 } },
        },
      ])
    ).toEqual([]);
  });

  it("returns an empty list for no docs", () => {
    expect(priorVerdictsFromDocs([])).toEqual([]);
  });
});
