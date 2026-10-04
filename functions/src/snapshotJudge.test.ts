import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NullJudge, judgeFor, ClaudeJudge, GeminiJudge } from "./snapshotJudge";

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
  const both = { anthropic: "sk-test-key", gemini: "AQ-test-key" };

  it("returns NullJudge for a disabled provider", () => {
    expect(judgeFor("null", both, "m")).toBeInstanceOf(NullJudge);
  });
  it("returns NullJudge for an unknown provider", () => {
    expect(judgeFor("llama", both, "m")).toBeInstanceOf(NullJudge);
  });
  it("returns NullJudge when the api key is missing", () => {
    expect(judgeFor("claude", {}, "m")).toBeInstanceOf(NullJudge);
  });
  it("returns ClaudeJudge when provider is claude and an api key is present", () => {
    expect(judgeFor("claude", both, "m")).toBeInstanceOf(ClaudeJudge);
  });
  it("returns GeminiJudge when provider is gemini and an api key is present", () => {
    expect(judgeFor("gemini", both, "m")).toBeInstanceOf(GeminiJudge);
  });

  // Keys are per-provider: holding the OTHER provider's key is not holding
  // this one's, or we would hand a Gemini judge an Anthropic credential.
  it("returns NullJudge for gemini when only the anthropic key is set", () => {
    expect(judgeFor("gemini", { anthropic: "sk-test-key" }, "m")).toBeInstanceOf(NullJudge);
  });
  it("returns NullJudge for claude when only the gemini key is set", () => {
    expect(judgeFor("claude", { gemini: "AQ-test-key" }, "m")).toBeInstanceOf(NullJudge);
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

describe("GeminiJudge", () => {
  const JPEG = Buffer.from([0xff, 0xd8, 0xff]);
  let fetchMock: ReturnType<typeof vi.fn>;

  // Builds the Gemini REST envelope: the verdict JSON arrives as a STRING in
  // candidates[0].content.parts[0].text, not as a nested object.
  function reply(payload: unknown, ok = true, status = 200) {
    return {
      ok,
      status,
      json: async () => ({
        candidates: [{ content: { parts: [{ text: JSON.stringify(payload) }] } }],
      }),
    };
  }

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns the parsed verdict from a canned safe response", async () => {
    fetchMock.mockResolvedValue(reply({ verdict: "safe", reason: "empty yard" }));

    const result = await new GeminiJudge("AQ-test-key").judge(JPEG, ctx);

    expect(result).toEqual({ verdict: "safe", reason: "empty yard" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("returns a breach verdict unchanged", async () => {
    fetchMock.mockResolvedValue(reply({ verdict: "breach", reason: "person at the gate" }));

    const result = await new GeminiJudge("AQ-test-key").judge(JPEG, ctx);

    expect(result).toEqual({ verdict: "breach", reason: "person at the gate" });
  });

  it("fails safe on a non-200 response", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 400, json: async () => ({}) });

    const result = await new GeminiJudge("AQ-test-key").judge(JPEG, ctx);

    expect(result).toEqual({ verdict: "breach", reason: "judge error (fail-safe)" });
  });

  it("fails safe when the response body has no candidate text", async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({}) });

    const result = await new GeminiJudge("AQ-test-key").judge(JPEG, ctx);

    expect(result).toEqual({ verdict: "breach", reason: "judge error (fail-safe)" });
  });

  it("fails safe when the candidate text is not valid JSON", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ candidates: [{ content: { parts: [{ text: "not json" }] } }] }),
    });

    const result = await new GeminiJudge("AQ-test-key").judge(JPEG, ctx);

    expect(result).toEqual({ verdict: "breach", reason: "judge error (fail-safe)" });
  });

  it("fails safe when the verdict field is neither safe nor breach", async () => {
    fetchMock.mockResolvedValue(reply({ verdict: "unsure", reason: "not sure" }));

    const result = await new GeminiJudge("AQ-test-key").judge(JPEG, ctx);

    expect(result).toEqual({ verdict: "breach", reason: "judge error (fail-safe)" });
  });

  it("fails safe when fetch itself throws", async () => {
    fetchMock.mockRejectedValue(new Error("network error"));

    const result = await new GeminiJudge("AQ-test-key").judge(JPEG, ctx);

    expect(result).toEqual({ verdict: "breach", reason: "judge error (fail-safe)" });
  });

  it("sends the image and the shared prompt, and names the camera", async () => {
    fetchMock.mockResolvedValue(reply({ verdict: "safe", reason: "empty" }));

    await new GeminiJudge("AQ-test-key").judge(JPEG, { ...ctx, cameraName: "Front door" });

    const [, init] = fetchMock.mock.calls[0];
    const body = JSON.parse(init.body as string);
    const [imagePart, textPart] = body.contents[0].parts;

    expect(imagePart.inline_data.mime_type).toBe("image/jpeg");
    expect(imagePart.inline_data.data).toBe(JPEG.toString("base64"));
    expect(textPart.text).toContain("Front door");
    // The homeowner's scene notes must reach the model, or the quirk list is
    // silently ignored and every swaying tree becomes a breach.
    expect(textPart.text).toContain("ignore the parked white car and swaying trees");
  });

  it("falls back to the channel number when the camera is unnamed", async () => {
    fetchMock.mockResolvedValue(reply({ verdict: "safe", reason: "empty" }));

    await new GeminiJudge("AQ-test-key").judge(JPEG, { ...ctx, channel: 4 });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.contents[0].parts[1].text).toContain("camera 4");
  });

  it("defaults to the pinned flash-lite model and passes the key as a header", async () => {
    fetchMock.mockResolvedValue(reply({ verdict: "safe", reason: "empty" }));

    await new GeminiJudge("AQ-test-key").judge(JPEG, ctx);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain("gemini-3.5-flash-lite");
    // Key in a header, never in the query string: URLs land in server logs.
    expect(init.headers["X-goog-api-key"]).toBe("AQ-test-key");
    expect(String(url)).not.toContain("AQ-test-key");
  });

  it("uses an explicitly configured model over the default", async () => {
    fetchMock.mockResolvedValue(reply({ verdict: "safe", reason: "empty" }));

    await new GeminiJudge("AQ-test-key", "gemini-flash-latest").judge(JPEG, ctx);

    expect(fetchMock.mock.calls[0][0]).toContain("gemini-flash-latest");
  });
});
