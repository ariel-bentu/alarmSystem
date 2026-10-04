// Server-only judge credentials.
//
// The AI-judge API keys live in the root-level `config/judge` document, which
// firestore.rules locks to `allow read, write: if false` — no client can reach
// it, only Cloud Functions via the admin SDK (which bypasses rules).
//
// They are deliberately NOT fields on projects/{projectId}: that doc is
// readable by any project MEMBER, so a key there would be downloaded in
// plaintext by every member's browser. An LLM API key is a billable internet
// credential, unlike the LAN-scoped nvrPassword stored alongside it.
//
// One shared doc serves every project. Per-project keys, if ever needed, fit
// the same rules block as `config/judge_{projectId}` without a rules change.

import type { Firestore } from "firebase-admin/firestore";

export interface JudgeKeys {
  anthropic?: string;
  gemini?: string;
}

export const JUDGE_CONFIG_PATH = "config/judge";

/**
 * Reads the judge API keys. NEVER throws and never rejects: a missing doc, a
 * missing field, or a Firestore read failure all resolve to an empty/partial
 * key set. The caller turns a missing key into a NullJudge, which fails safe
 * to "breach" — so a credential problem can only ever make the system noisier,
 * never suppress an alarm.
 */
export async function loadJudgeKeys(
  db: Pick<Firestore, "doc">
): Promise<JudgeKeys> {
  try {
    const snap = await db.doc(JUDGE_CONFIG_PATH).get();
    if (!snap.exists) return {};
    const data = snap.data() ?? {};
    const keys: JudgeKeys = {};
    if (typeof data.anthropicApiKey === "string" && data.anthropicApiKey.trim() !== "") {
      keys.anthropic = data.anthropicApiKey;
    }
    if (typeof data.geminiApiKey === "string" && data.geminiApiKey.trim() !== "") {
      keys.gemini = data.geminiApiKey;
    }
    return keys;
  } catch (e) {
    console.error(`loadJudgeKeys: failed to read ${JUDGE_CONFIG_PATH}`, e);
    return {};
  }
}
