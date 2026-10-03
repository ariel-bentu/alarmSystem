// Explore page: unified event timeline, live for today+yesterday and paged
// backwards from there.
import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import {
  getDocs,
  onSnapshot,
  query,
  where,
  orderBy,
  limit,
  startAfter,
  Timestamp,
  type QueryDocumentSnapshot,
} from "firebase/firestore";
import { useProject } from "@/app/ProjectProvider";
import { eventsCol, timelineCol } from "@/lib/firestore";
import { liveWindowStart, mergeEventPages } from "./eventPaging";
import { eventSubject } from "./eventSubject";
import { snapshotSummary } from "./snapshotThumb";
import { DayHeaderRow } from "@/components/DayHeaderRow";
import { groupItemsByDay } from "@/features/configure/groupSensorsByDay";
import {
  relativeSuffix,
  timeOfDaySeconds,
} from "@/features/configure/lastSeenFormat";
import { useT } from "@/i18n/I18nProvider";
import type { TranslationKey } from "@/i18n/en";
import type { AlarmEvent, TimelineSnapshotDoc } from "@/types";

// Events older than the live window load a page at a time. "Load all" loops
// this same page size rather than issuing one unbounded query, so a long
// history streams in instead of hanging on a single huge read.
const PAGE_SIZE = 100;

// Events that came from a physical RF packet, and therefore have a real
// battery flag and signal strength. Arm/disarm originate in the app.
// `water` and `close` belong here for the same reason `trigger` does: both
// are real received packets and carry a genuine RSSI and battery flag. That
// `close` drives no siren, alert or rule is a POLICY decision made in the
// cloud — it does not make the measurement less real, and the timeline is
// the complete history.
const RADIO_EVENTS = new Set([
  "trigger",
  "tamper",
  "battery_low",
  "water",
  "close",
  "alarm",
]);

// Controller lifecycle rather than sensor activity: restart, offline, back
// online. Rendered muted, since "the box rebooted" is context for the events
// around it rather than an event on the premises.
const SYSTEM_EVENTS = new Set([
  "device_restart",
  "device_offline",
  "device_online",
]);
const isSystemEvent = (eventType: string) => SYSTEM_EVENTS.has(eventType);

// Whether to show battery/RSSI columns for a row.
//
// Membership in RADIO_EVENTS is necessary but NOT sufficient: an "alarm" row
// written by onAlarm describes a rule firing, not a packet, and carries
// rssi: 0 with no battery reading. Showing "No" and "0" there would invent
// measurements that were never taken — the same reasoning the arm/disarm
// comment below already makes. So require an actual sensor as well.
const hasRadioData = (ev: AlarmEvent) =>
  RADIO_EVENTS.has(ev.eventType) && Boolean(ev.rfId);

export default function ExplorePage() {
  const t = useT();
  const { project } = useProject();
  const projectId = project?.id;

  // Two layers. `live` is a listener over today+yesterday, so a trigger still
  // appears without a reload. `history` is everything older, fetched one page
  // at a time with getDocs — those rows are settled and will never change, so
  // keeping a listener on each loaded page would cost reads for nothing.
  const [live, setLive] = useState<AlarmEvent[]>([]);
  const [history, setHistory] = useState<AlarmEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [exhausted, setExhausted] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  // Camera snapshots + AI verdict live on a SEPARATE collection
  // (projects/{id}/timeline, doc id `{rfId}_{ts}`) written by
  // onSnapshotUploaded — never on the AlarmEvent row itself. Kept as a flat
  // map keyed by that same id so each rendered row can look itself up in
  // O(1); un-matched rows (the vast majority, since most triggers have no
  // camera) simply get `undefined` back from the map.
  const [timelineById, setTimelineById] = useState<
    Map<string, TimelineSnapshotDoc>
  >(new Map());

  // Full-size view of one clicked snapshot. null = closed.
  const [expandedUrl, setExpandedUrl] = useState<string | null>(null);
  const lightboxRef = useRef<HTMLDialogElement>(null);

  // Paging walks a document cursor, not a computed date: with a fixed page
  // size, nothing about a timestamp says where page 2 begins.
  const cursor = useRef<QueryDocumentSnapshot<AlarmEvent> | null>(null);
  // Guards against a page (or a whole "Load all" loop) resolving after the
  // project changed underneath it.
  const generation = useRef(0);
  // The live/history split is pinned at mount. Recomputing it would silently
  // shift the boundary past midnight and re-fetch pages already on screen.
  const boundary = useRef<Timestamp>(
    Timestamp.fromMillis(liveWindowStart(Date.now()))
  );

  useEffect(() => {
    // Switching project invalidates both layers and the cursor into them.
    // Bumping the generation abandons any page still in flight for the old
    // project, which would otherwise append its rows into the new one.
    generation.current += 1;
    cursor.current = null;
    setLive([]);
    setHistory([]);
    setExhausted(false);

    if (!projectId) {
      setLoading(false);
      return;
    }

    setLoading(true);
    const q = query(
      eventsCol(projectId),
      where("timestamp", ">=", boundary.current),
      orderBy("timestamp", "desc")
    );

    const unsub = onSnapshot(q, (snap) => {
      setLive(snap.docs.map((d) => d.data()));
      setLoading(false);
    });

    return unsub;
  }, [projectId]);

  // Separate listener over the whole `timeline` collection (unbounded by the
  // live/history day split above — a snapshot can land anytime after the
  // triggering event). This mirrors the events listener's lifecycle: one
  // subscription per project, cleaned up via the returned unsubscribe when
  // the project changes or the page unmounts.
  useEffect(() => {
    setTimelineById(new Map());
    if (!projectId) return;

    const unsub = onSnapshot(timelineCol(projectId), (snap) => {
      setTimelineById(new Map(snap.docs.map((d) => [d.id, d.data()])));
    });

    return unsub;
  }, [projectId]);

  // Native <dialog> + showModal(), same pattern as the pair dialog in
  // SensorsTab: the platform gives focus trapping, Esc-to-close and the top
  // layer for free, none of which happen from merely rendering `open`.
  useEffect(() => {
    const el = lightboxRef.current;
    if (!el) return;
    if (expandedUrl && !el.open) el.showModal();
    if (!expandedUrl && el.open) el.close();
  }, [expandedUrl]);

  /** Fetch the next page of history. Returns false once the end is reached. */
  const loadPage = useCallback(async (): Promise<boolean> => {
    if (!projectId) return false;

    const mine = generation.current;
    const after = cursor.current;
    const q = query(
      eventsCol(projectId),
      where("timestamp", "<", boundary.current),
      orderBy("timestamp", "desc"),
      ...(after ? [startAfter(after)] : []),
      limit(PAGE_SIZE)
    );

    const snap = await getDocs(q);
    // Stale result: the project changed while this page was in flight.
    if (generation.current !== mine) return false;

    if (snap.docs.length > 0) {
      cursor.current = snap.docs[snap.docs.length - 1];
      setHistory((prev) => [...prev, ...snap.docs.map((d) => d.data())]);
    }

    // A short page means the collection is spent. An exactly-full page leaves
    // it unknown, so the controls stay until a later page comes back short.
    const more = snap.docs.length === PAGE_SIZE;
    if (!more) setExhausted(true);
    return more;
  }, [projectId]);

  const loadMore = useCallback(async () => {
    setLoadingMore(true);
    try {
      await loadPage();
    } finally {
      setLoadingMore(false);
    }
  }, [loadPage]);

  const loadAll = useCallback(async () => {
    setLoadingMore(true);
    try {
      while (await loadPage()) {
        // Each iteration appends a page, so the table grows as it goes.
      }
    } finally {
      setLoadingMore(false);
    }
  }, [loadPage]);

  // Keeps the newest event's relative time honest without a reload.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 10_000);
    return () => clearInterval(id);
  }, []);

  const events = mergeEventPages(live, history);
  const eventDayGroups = groupItemsByDay(
    events,
    (ev) => ev.timestamp.toMillis(),
    now
  );

  if (!project) {
    return <p>{t("ops.noProject")}</p>;
  }

  return (
    <div>
      <h1 className="sr-only">{t("explore.title")}</h1>

      <div className="card">
        {loading ? (
          <p>{t("explore.loading")}</p>
        ) : events.length === 0 ? (
          <p className="muted">{t("explore.noEvents")}</p>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>{t("explore.timestamp")}</th>
                  <th>{t("explore.sensor")}</th>
                  <th>{t("explore.event")}</th>
                  <th>{t("explore.batteryLow")}</th>
                  <th>{t("explore.rssi")}</th>
                  <th>{t("explore.camera")}</th>
                </tr>
              </thead>
              <tbody>
                {eventDayGroups.map((group) => (
                  <Fragment key={group.dayKey}>
                    <DayHeaderRow
                      date={group.date}
                      isToday={group.isToday}
                      isNever={group.isNever}
                      colSpan={6}
                    />
                    {group.items.map((ev, i) => {
                      const ts = ev.timestamp.toMillis();
                      // Relative phrasing on the newest row only — that is the
                      // one being checked live. null past 24h, see
                      // relativeSuffix.
                      const ago =
                        group === eventDayGroups[0] && i === 0
                          ? relativeSuffix(ts, now, t)
                          : null;
                      // The join: onSnapshotUploaded writes the timeline doc
                      // id as `${rfId}_${ts}` using the SAME epoch-ms the
                      // device/cloud stamped the triggering event with, so
                      // this key recreates that id from the displayed row.
                      const timelineKey = `${ev.rfId}_${ts}`;
                      const timelineEntry = timelineById.get(timelineKey);
                      const { hasImages, verdictLabel } =
                        snapshotSummary(timelineEntry);
                      const verdictKey: TranslationKey | undefined =
                        verdictLabel === "Confirmed breach (AI)"
                          ? "explore.verdict.breach"
                          : verdictLabel === "False positive (AI)"
                            ? "explore.verdict.safe"
                            : undefined;
                      return (
                        <tr
                          key={ev.id}
                          className={isSystemEvent(ev.eventType) ? "muted" : undefined}
                        >
                          {/* The date is already in the heading above, so rows
                              show only a time — but to the second, because
                              spacing between triggers is what count_in_window
                              and multi_sensor rules are tuned from. The newest
                              event also carries "(5 minutes ago)" beside it;
                              that is the live-glance row, and the relative
                              phrasing is an addition to the exact time now,
                              never a replacement for it. */}
                          <td>
                            {/* .ltr keeps "14:23:05" in that order inside the
                                RTL layout — without it the colon-separated
                                parts get reordered. */}
                            <span className="ltr">{timeOfDaySeconds(ts)}</span>
                            {ago && <span className="muted"> ({ago})</span>}
                          </td>
                          {/* sensorName is "what this event is about": a
                              sensor, a profile, a remote's name, or a raw
                              reset reason. armSource says WHICH of those an
                              arm/disarm row carries — without it a profile
                              name was rendered as a remote. eventSubject()
                              translates and decorates per event type — see
                              there. Rows written before it was stored are
                              empty, hence the System fallback. */}
                          <td>
                            {eventSubject(
                              ev.eventType,
                              ev.sensorName,
                              t,
                              ev.armSource
                            ) || (
                              <span className="muted">{t("explore.system")}</span>
                            )}
                          </td>
                          <td>
                            {t(`explore.eventType.${ev.eventType}` as TranslationKey)}
                          </td>
                          {/* Battery and RSSI describe a radio packet. An
                              arm/disarm came from the app, so showing "No"
                              and "0" would invent data that was never
                              measured. */}
                          <td>
                            {hasRadioData(ev)
                              ? ev.batteryLow
                                ? t("common.yes")
                                : t("common.no")
                              : "—"}
                          </td>
                          <td>
                            {hasRadioData(ev) ? (
                              <span className="ltr">{ev.rssi}</span>
                            ) : (
                              "—"
                            )}
                          </td>
                          {/* Snapshots + AI verdict come from the SEPARATE
                              `timeline` collection, joined above by
                              `${rfId}_${ts}` — most rows have no match
                              (no camera on the sensor, or NVR off), hence the
                              "—" fallback matching the other radio-only
                              columns. */}
                          <td>
                            {hasImages ? (
                              <div className="row" style={{ gap: "var(--sp-2)" }}>
                                {timelineEntry?.snapshots?.map((snap) => (
                                  <button
                                    key={snap.channel}
                                    type="button"
                                    className="snapshot-thumb-btn"
                                    onClick={() => setExpandedUrl(snap.url)}
                                    aria-label={t("explore.snapshotAlt", {
                                      channel: snap.channel,
                                    })}
                                  >
                                    <img
                                      src={snap.url}
                                      alt={t("explore.snapshotAlt", {
                                        channel: snap.channel,
                                      })}
                                      className="snapshot-thumb"
                                    />
                                  </button>
                                ))}
                                {verdictKey && (
                                  <span
                                    className={
                                      verdictLabel === "Confirmed breach (AI)"
                                        ? "badge badge--danger"
                                        : "badge badge--ok"
                                    }
                                  >
                                    {t(verdictKey)}
                                  </span>
                                )}
                              </div>
                            ) : (
                              "—"
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* Paging controls. Hidden until the live window has rendered, so the
            page never offers to load older events before showing recent ones.
            "Load all" reads the whole collection — see the loop in loadAll. */}
        {!loading && (
          <div className="row" style={{ marginBlockStart: "var(--sp-4)" }}>
            {exhausted ? (
              <span className="muted">{t("explore.allLoaded")}</span>
            ) : (
              <>
                <button
                  type="button"
                  className="btn btn--sm"
                  onClick={loadMore}
                  disabled={loadingMore}
                >
                  {t("explore.loadMore")}
                </button>
                <button
                  type="button"
                  className="btn btn--sm btn--ghost"
                  onClick={loadAll}
                  disabled={loadingMore}
                >
                  {t("explore.loadAll")}
                </button>
              </>
            )}
            <span className="muted spacer">
              {loadingMore
                ? t("explore.loadingMore")
                : t("explore.loadedCount", { count: events.length })}
            </span>
          </div>
        )}
      </div>

      {/* Lightbox: click a thumbnail to see it full-size, click again or the
          backdrop (native <dialog> behaviour) to close. No existing
          image-expand precedent elsewhere in the app, so this keeps the
          interaction to that one gesture rather than inventing a fuller
          gallery/carousel. */}
      <dialog
        ref={lightboxRef}
        className="modal"
        onClose={() => setExpandedUrl(null)}
        onClick={(e) => {
          if (e.target === e.currentTarget) setExpandedUrl(null);
        }}
      >
        {expandedUrl && (
          <div className="modal__body">
            <img
              src={expandedUrl}
              alt={t("explore.expandedSnapshotAlt")}
              style={{ maxWidth: "100%", maxHeight: "80vh", display: "block" }}
              onClick={() => setExpandedUrl(null)}
            />
          </div>
        )}
      </dialog>
    </div>
  );
}
