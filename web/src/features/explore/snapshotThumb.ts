// Pure helper: turns a joined timeline entry (or undefined, when a trigger
// has no matching snapshot doc) into the two facts the ExplorePage row needs
// to render — whether to show a thumbnail strip, and what verdict badge text
// to show, if any.
//
// There is NO structured verdict field on TimelineSnapshotDoc. onSnapshotUploaded
// (functions/src/onSnapshotUploaded.ts) embeds the AI judge's verdict in a
// free-text `aiNote` string: "confirmed breach (AI): <reason>", "false
// positive (AI): <reason>", or a withheld-advisory variant that also starts
// "safe (AI, channel N): ...". This matches on those prefixes rather than a
// `judge.verdict` enum, because the cloud side never writes one.
import type { TimelineSnapshotDoc } from "@/types";

export interface SnapshotSummary {
  hasImages: boolean;
  verdictLabel?: string;
}

export function snapshotSummary(
  entry: TimelineSnapshotDoc | undefined
): SnapshotSummary {
  const hasImages = Boolean(entry?.snapshots && entry.snapshots.length > 0);

  const note = entry?.aiNote;
  let verdictLabel: string | undefined;
  if (note) {
    if (note.startsWith("confirmed breach")) {
      verdictLabel = "Confirmed breach (AI)";
    } else if (note.startsWith("false positive")) {
      verdictLabel = "False positive (AI)";
    } else if (note.startsWith("safe")) {
      // The withheld-advisory path: a sibling channel already recorded a
      // breach, so this channel's own "safe" verdict is logged but not
      // surfaced as a false positive — the alarm stands.
      verdictLabel = "False positive (AI)";
    }
  }

  return { hasImages, verdictLabel };
}
