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

export function judgeFor(
  provider: string | undefined,
  apiKey: string | undefined,
  _model: string | undefined,
): SnapshotJudge {
  if (provider !== "claude" || !apiKey) {
    return new NullJudge();
  }

  // ClaudeJudge wired in Task 11
  return new NullJudge();
}
