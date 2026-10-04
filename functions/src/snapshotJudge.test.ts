import { describe, it, expect, vi, beforeEach } from "vitest";
import { NullJudge, judgeFor, ClaudeJudge } from "./snapshotJudge";

const mockParse = vi.fn();

vi.mock("@anthropic-ai/sdk", () => {
  return {
    default: vi.fn().mockImplementation(() => ({
      messages: {
        parse: mockParse,
      },
    })),
  };
});

const ctx = {
  sensorName: "Front", channel: 1, armed: true, timeOfDay: "day",
  prompt: "ignore the parked white car and swaying trees",
};

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
  it("returns ClaudeJudge when provider is claude and an api key is present", () => {
    expect(judgeFor("claude", "sk-test-key", "m")).toBeInstanceOf(ClaudeJudge);
  });
});

describe("ClaudeJudge", () => {
  beforeEach(() => {
    mockParse.mockReset();
  });

  it("returns the parsed verdict from a canned safe response", async () => {
    mockParse.mockResolvedValue({
      parsed_output: { verdict: "safe", reason: "empty yard" },
    });

    const judge = new ClaudeJudge("sk-test-key", "m");
    const result = await judge.judge(Buffer.from([0xff, 0xd8]), ctx);

    expect(result).toEqual({ verdict: "safe", reason: "empty yard" });
    expect(mockParse).toHaveBeenCalledTimes(1);
  });

  it("fails safe when parsed_output is null (malformed/unparseable response)", async () => {
    mockParse.mockResolvedValue({ parsed_output: null });

    const judge = new ClaudeJudge("sk-test-key", "m");
    const result = await judge.judge(Buffer.from([0xff, 0xd8]), ctx);

    expect(result).toEqual({ verdict: "breach", reason: "judge error (fail-safe)" });
  });

  it("fails safe when the verdict field is neither safe nor breach", async () => {
    mockParse.mockResolvedValue({
      parsed_output: { verdict: "unsure", reason: "not sure" },
    });

    const judge = new ClaudeJudge("sk-test-key", "m");
    const result = await judge.judge(Buffer.from([0xff, 0xd8]), ctx);

    expect(result).toEqual({ verdict: "breach", reason: "judge error (fail-safe)" });
  });

  it("fails safe when the SDK call throws", async () => {
    mockParse.mockRejectedValue(new Error("network error"));

    const judge = new ClaudeJudge("sk-test-key", "m");
    const result = await judge.judge(Buffer.from([0xff, 0xd8]), ctx);

    expect(result).toEqual({ verdict: "breach", reason: "judge error (fail-safe)" });
  });

  // The camera's human name is better scene context for a vision model than a
  // bare channel number: "Front door" says what the frame should contain.
  it("names the camera in the prompt when the channel has a name", async () => {
    mockParse.mockResolvedValue({
      parsed_output: { verdict: "safe", reason: "empty" },
    });

    const judge = new ClaudeJudge("sk-test-key", "m");
    await judge.judge(Buffer.from([0xff, 0xd8]), {
      ...ctx,
      cameraName: "Front door",
    });

    const text = mockParse.mock.calls[0][0].messages[0].content[1].text;
    expect(text).toContain("Front door");
  });

  it("falls back to the channel number when the camera is unnamed", async () => {
    mockParse.mockResolvedValue({
      parsed_output: { verdict: "safe", reason: "empty" },
    });

    const judge = new ClaudeJudge("sk-test-key", "m");
    await judge.judge(Buffer.from([0xff, 0xd8]), { ...ctx, channel: 4 });

    const text = mockParse.mock.calls[0][0].messages[0].content[1].text;
    expect(text).toContain("camera 4");
  });
});
