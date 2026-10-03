import { describe, it, expect } from "vitest";
import { NullJudge, judgeFor } from "./snapshotJudge";

describe("NullJudge", () => {
  it("fails safe: always breach (nothing is suppressed when judging is off)", async () => {
    const v = await new NullJudge().judge(Buffer.from([0xff, 0xd8]), {
      sensorName: "Front", channel: 1, armed: true, timeOfDay: "day", prompt: "",
    });
    expect(v.verdict).toBe("breach");
    expect(v.reason).toBe("judge disabled");
  });
});

describe("judgeFor", () => {
  it("returns NullJudge when provider is not claude", () => {
    expect(judgeFor("null", "key", "m")).toBeInstanceOf(NullJudge);
  });
  it("returns NullJudge when the api key is missing", () => {
    expect(judgeFor("claude", undefined, "m")).toBeInstanceOf(NullJudge);
  });
});
