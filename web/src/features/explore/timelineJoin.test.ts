import { describe, it, expect } from "vitest";
import { findOrphanTimeline, JOIN_SKEW_MS } from "./timelineJoin";

const RF = "0x0061DA";
const TS = 1791217484000;

const ev = (rfId: string, ms: number) => ({ rfId, ms });
const tl = (id: string, ms: number) => ({ id, ms });

describe("findOrphanTimeline", () => {
  it("matches a timeline doc to an event with the same rfId and ts", () => {
    expect(
      findOrphanTimeline([tl(`${RF}_${TS}`, TS)], [ev(RF, TS)]).map((t) => t.id)
    ).toEqual([]);
  });

  // The device used to read time(nullptr) twice per trigger — once for the
  // snapshot path, once inside reportEvent — so a trigger straddling a second
  // boundary produced an /events key 1000ms off the snapshot's. Seen live on
  // 2026-10-05: timeline 19:24:44 vs event 19:24:45, which rendered a real
  // sensor trigger as "manual capture". The firmware now passes ONE timestamp,
  // but historical rows already carry the skew, so the join must tolerate it.
  it("matches across a 1-second skew in either direction", () => {
    expect(
      findOrphanTimeline([tl(`${RF}_${TS}`, TS)], [ev(RF, TS + 1000)])
    ).toEqual([]);
    expect(
      findOrphanTimeline([tl(`${RF}_${TS}`, TS)], [ev(RF, TS - 1000)])
    ).toEqual([]);
  });

  it("does not match beyond the skew tolerance", () => {
    const far = TS + JOIN_SKEW_MS + 1;
    expect(
      findOrphanTimeline([tl(`${RF}_${TS}`, TS)], [ev(RF, far)]).map((t) => t.id)
    ).toEqual([`${RF}_${TS}`]);
  });

  // A different sensor at the same instant must never absorb the timeline doc.
  it("requires the rfId to match", () => {
    expect(
      findOrphanTimeline([tl(`${RF}_${TS}`, TS)], [ev("0x54247E", TS)]).map((t) => t.id)
    ).toEqual([`${RF}_${TS}`]);
  });

  // A genuine manual capture has rfId "MANUAL" and no event row at all — it
  // MUST stay an orphan, since surfacing it is the whole reason orphans render.
  it("keeps a real manual capture as an orphan", () => {
    expect(
      findOrphanTimeline([tl(`MANUAL_${TS}`, TS)], [ev(RF, TS)]).map((t) => t.id)
    ).toEqual([`MANUAL_${TS}`]);
  });

  it("returns every unmatched doc and nothing else", () => {
    const orphans = findOrphanTimeline(
      [tl(`${RF}_${TS}`, TS), tl(`MANUAL_${TS + 5000}`, TS + 5000)],
      [ev(RF, TS + 1000)]
    );
    expect(orphans.map((t) => t.id)).toEqual([`MANUAL_${TS + 5000}`]);
  });

  it("handles empty inputs", () => {
    expect(findOrphanTimeline([], [ev(RF, TS)])).toEqual([]);
    expect(findOrphanTimeline([tl(`${RF}_${TS}`, TS)], []).map((t) => t.id)).toEqual([
      `${RF}_${TS}`,
    ]);
  });
});
