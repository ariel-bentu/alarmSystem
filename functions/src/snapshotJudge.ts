import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import type { JudgeKeys } from "./judgeConfig";

export type Verdict = "safe" | "breach";

export interface JudgeContext {
  sensorName: string;
  channel: number;
  // The channel's human name from project.cameraNames, when it has one.
  // Better scene context for a vision model than a bare number — "Front door"
  // says what the frame should contain. Absent for an unnamed channel, which
  // falls back to "camera N".
  cameraName?: string;
  armed: boolean;
  timeOfDay: string;
  prompt: string;
}

export interface SnapshotJudge {
  judge(jpeg: Buffer, ctx: JudgeContext): Promise<{ verdict: Verdict; reason: string }>;
}

export class NullJudge implements SnapshotJudge {
  async judge(_jpeg: Buffer, _ctx: JudgeContext): Promise<{ verdict: Verdict; reason: string }> {
    return { verdict: "breach", reason: "judge disabled" };
  }
}

const DEFAULT_CLAUDE_MODEL = "claude-haiku-4-5";

// Pinned, NOT the "gemini-flash-lite-latest" alias: that alias currently
// resolves to a 2.5-era model and can be repointed by Google at any time. An
// alarm system should not change its judging behaviour on someone else's
// release schedule.
const DEFAULT_GEMINI_MODEL = "gemini-3.5-flash-lite";

const VerdictSchema = z.object({
  verdict: z.enum(["safe", "breach"]),
  reason: z.string(),
});

/**
 * The judging prompt, shared by every provider so their wording cannot drift
 * apart — a verdict must mean the same thing whichever model produced it.
 */
export function buildPrompt(ctx: JudgeContext): string {
  return (
    "You are a home security camera monitor. Look at this single still frame from " +
    `sensor "${ctx.sensorName}" (${
      ctx.cameraName ? `camera "${ctx.cameraName}"` : `camera ${ctx.channel}`
    }), captured during ${ctx.timeOfDay}, ` +
    `while the system is ${ctx.armed ? "armed" : "disarmed"}.\n\n` +
    `Scene notes from the homeowner (ignore these known quirks): ${ctx.prompt || "(none)"}\n\n` +
    "Decide whether a person or intruder is visible in the frame. Respond with verdict " +
    '"breach" if and only if a person or intruder is visible. If the frame is empty, ' +
    'ambiguous, or shows only the known quirks above, respond "safe". Give a brief reason.'
  );
}

const FAIL_SAFE = { verdict: "breach" as const, reason: "judge error (fail-safe)" };

/**
 * Vision-model judge: sends the camera JPEG to Claude along with the
 * per-project scene-quirk prompt and asks whether a person/intruder is
 * visible. FAIL-SAFE: any error, malformed response, or non-"safe"/"breach"
 * verdict resolves to `breach` — a broken judge must never suppress an alarm.
 */
export class ClaudeJudge implements SnapshotJudge {
  private readonly client: Anthropic;
  private readonly model: string;

  constructor(apiKey: string, model?: string) {
    this.client = new Anthropic({ apiKey });
    this.model = model || DEFAULT_CLAUDE_MODEL;
  }

  async judge(jpeg: Buffer, ctx: JudgeContext): Promise<{ verdict: Verdict; reason: string }> {
    try {
      const message = await this.client.messages.parse({
        model: this.model,
        max_tokens: 1024,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "image",
                source: { type: "base64", media_type: "image/jpeg", data: jpeg.toString("base64") },
              },
              { type: "text", text: buildPrompt(ctx) },
            ],
          },
        ],
        output_config: {
          format: zodOutputFormat(VerdictSchema),
        },
      });

      const parsed = message.parsed_output;
      if (!parsed || (parsed.verdict !== "safe" && parsed.verdict !== "breach")) {
        return FAIL_SAFE;
      }

      return { verdict: parsed.verdict, reason: parsed.reason };
    } catch {
      return FAIL_SAFE;
    }
  }
}

// Gemini's structured-output equivalent of VerdictSchema above.
const GEMINI_RESPONSE_SCHEMA = {
  type: "OBJECT",
  properties: {
    verdict: { type: "STRING", enum: ["safe", "breach"] },
    reason: { type: "STRING" },
  },
  required: ["verdict", "reason"],
};

/**
 * Vision-model judge backed by the Gemini REST API. Same contract and the same
 * FAIL-SAFE posture as ClaudeJudge: any error, non-200, malformed body, or
 * unrecognised verdict resolves to `breach`.
 *
 * Plain `fetch` rather than @google/genai — the request is one POST and the
 * SDK would be another dependency to cold-start.
 *
 * NOTE: no `thinkingConfig`. Setting `thinkingBudget: 0` makes flash-lite
 * reject the whole request with a bare HTTP 400 INVALID_ARGUMENT that names no
 * field; the lite models answer in ~1.3s without it anyway.
 */
export class GeminiJudge implements SnapshotJudge {
  private readonly apiKey: string;
  private readonly model: string;

  constructor(apiKey: string, model?: string) {
    this.apiKey = apiKey;
    this.model = model || DEFAULT_GEMINI_MODEL;
  }

  async judge(jpeg: Buffer, ctx: JudgeContext): Promise<{ verdict: Verdict; reason: string }> {
    try {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-goog-api-key": this.apiKey,
          },
          body: JSON.stringify({
            contents: [
              {
                parts: [
                  {
                    inline_data: {
                      mime_type: "image/jpeg",
                      data: jpeg.toString("base64"),
                    },
                  },
                  { text: buildPrompt(ctx) },
                ],
              },
            ],
            generationConfig: {
              responseMimeType: "application/json",
              responseSchema: GEMINI_RESPONSE_SCHEMA,
            },
          }),
        }
      );

      if (!res.ok) {
        console.error(`GeminiJudge: HTTP ${res.status} from ${this.model}`);
        return FAIL_SAFE;
      }

      const body = (await res.json()) as {
        candidates?: { content?: { parts?: { text?: string }[] } }[];
      };
      const text = body.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!text) return FAIL_SAFE;

      const parsed = VerdictSchema.safeParse(JSON.parse(text));
      if (!parsed.success) return FAIL_SAFE;

      return { verdict: parsed.data.verdict, reason: parsed.data.reason };
    } catch {
      return FAIL_SAFE;
    }
  }
}

/**
 * Picks the judge for a project's configured provider. Returns NullJudge for
 * an unknown/disabled provider OR when the selected provider has no key —
 * NullJudge answers "breach", so a misconfiguration is noisy, never silent.
 */
export function judgeFor(
  provider: string | undefined,
  keys: JudgeKeys,
  model: string | undefined,
): SnapshotJudge {
  if (provider === "claude" && keys.anthropic) {
    return new ClaudeJudge(keys.anthropic, model);
  }
  if (provider === "gemini" && keys.gemini) {
    return new GeminiJudge(keys.gemini, model);
  }
  return new NullJudge();
}
