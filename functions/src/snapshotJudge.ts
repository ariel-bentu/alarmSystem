import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";

export type Verdict = "safe" | "breach";

export interface JudgeContext {
  sensorName: string;
  channel: number;
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

const VerdictSchema = z.object({
  verdict: z.enum(["safe", "breach"]),
  reason: z.string(),
});

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
              {
                type: "text",
                text:
                  "You are a home security camera monitor. Look at this single still frame from " +
                  `sensor "${ctx.sensorName}" (channel ${ctx.channel}), captured during ${ctx.timeOfDay}, ` +
                  `while the system is ${ctx.armed ? "armed" : "disarmed"}.\n\n` +
                  `Scene notes from the homeowner (ignore these known quirks): ${ctx.prompt || "(none)"}\n\n` +
                  "Decide whether a person or intruder is visible in the frame. Respond with verdict " +
                  '"breach" if and only if a person or intruder is visible. If the frame is empty, ' +
                  'ambiguous, or shows only the known quirks above, respond "safe". Give a brief reason.',
              },
            ],
          },
        ],
        output_config: {
          format: zodOutputFormat(VerdictSchema),
        },
      });

      const parsed = message.parsed_output;
      if (!parsed || (parsed.verdict !== "safe" && parsed.verdict !== "breach")) {
        return { verdict: "breach", reason: "judge error (fail-safe)" };
      }

      return { verdict: parsed.verdict, reason: parsed.reason };
    } catch {
      return { verdict: "breach", reason: "judge error (fail-safe)" };
    }
  }
}

export function judgeFor(
  provider: string | undefined,
  apiKey: string | undefined,
  model: string | undefined,
): SnapshotJudge {
  if (provider !== "claude" || !apiKey) {
    return new NullJudge();
  }

  return new ClaudeJudge(apiKey, model);
}
