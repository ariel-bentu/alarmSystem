// Pure helper: computes epoch ms cutoff for a given TimeRange value.
import type { TimeRange } from "@/types";

const MS_PER_DAY = 86_400_000;

/**
 * Returns the epoch-ms cutoff timestamp for the given range.
 * Events with timestamp >= cutoff are included in the timeline.
 */
export function rangeCutoff(range: TimeRange, now: number): number {
  switch (range) {
    case "day":
      return now - MS_PER_DAY;
    case "week":
      return now - 7 * MS_PER_DAY;
    case "month":
      return now - 30 * MS_PER_DAY;
    case "3months":
      return now - 90 * MS_PER_DAY;
    case "year":
      return now - 365 * MS_PER_DAY;
  }
}
