// Reading past verdicts for a sensor, so a trigger with no images of its own
// can inherit one. See judgeGate.reusableVerdict() for the window rule and
// docs/superpowers/specs/2026-10-05-judge-as-evidence-design.md for why reuse
// is forced rather than chosen.
//
// The coordination docs are keyed `{rfId}_{ts}` — the TRIGGER's ts — which is
// what makes this possible without a schema change: the timestamp reuse needs
// is already in the document id. The per-channel `at` field is a different
// clock (when the verdict was written, several seconds later) and must not be
// used for the window arithmetic.

import { Verdict } from "./snapshotJudge";
import { ChannelVerdictRecord } from "./judgeGate";

/** One channel's entry on a coordination doc. */
export interface StoredChannelVerdict {
  verdict: Verdict;
  reason: string;
  /** When the verdict was WRITTEN. Not the trigger ts — see module comment. */
  at: number;
}

export interface JudgingDocLike {
  id: string;
  channels?: Record<string, StoredChannelVerdict>;
}

export function judgingDocId(rfId: string, ts: number): string {
  return `${rfId}_${ts}`;
}

/**
 * Split a coordination doc id back into its parts, or null if it is not one.
 *
 * Splits on the LAST underscore: today's rfIds contain none, but a future id
 * shape with a prefix would otherwise mis-parse silently.
 */
export function parseJudgingDocId(id: string): { rfId: string; ts: number } | null {
  const cut = id.lastIndexOf("_");
  if (cut <= 0 || cut === id.length - 1) return null;
  const rfId = id.slice(0, cut);
  const tsRaw = id.slice(cut + 1);
  if (!/^\d+$/.test(tsRaw)) return null;
  const ts = Number(tsRaw);
  if (!Number.isFinite(ts)) return null;
  return { rfId, ts };
}

/**
 * Flatten sibling coordination docs into the verdict list reusableVerdict()
 * scans.
 *
 * Every channel of every doc becomes one record, stamped with the TRIGGER ts
 * from the doc id. A malformed id, a doc with no channels, or an unrecognised
 * verdict value is skipped rather than guessed at — a bad record here would
 * silently become evidence.
 */
export function priorVerdictsFromDocs(docs: JudgingDocLike[]): ChannelVerdictRecord[] {
  const out: ChannelVerdictRecord[] = [];
  for (const doc of docs) {
    const parsed = parseJudgingDocId(doc.id);
    if (!parsed) continue;
    for (const entry of Object.values(doc.channels ?? {})) {
      if (entry?.verdict !== "safe" && entry?.verdict !== "breach") continue;
      out.push({ ts: parsed.ts, verdict: entry.verdict, reason: entry.reason });
    }
  }
  return out;
}
