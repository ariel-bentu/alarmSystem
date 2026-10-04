// Explore page: unified event timeline, live for today+yesterday and paged
// backwards from there.
import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import {
  getDocs,
  onSnapshot,
  query,
  updateDoc,
  where,
  orderBy,
  limit,
  startAfter,
  Timestamp,
  type QueryDocumentSnapshot,
} from "firebase/firestore";
import { useProject } from "@/app/ProjectProvider";
import { eventsCol, projectDoc, timelineCol } from "@/lib/firestore";
import {
  cameraLabel,
  normalizeCameraNames,
  type CameraNames,
} from "./cameraNames";
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

  // Gallery state: null = closed, otherwise the snapshots array + current index.
  const [gallery, setGallery] = useState<{
    snapshots: { url: string; channel: number }[];
    index: number;
  } | null>(null);
  const lightboxRef = useRef<HTMLDialogElement>(null);

  // Camera-rename panel inside the gallery. `draft` is non-null only while
  // editing, and holds ONLY the channels in the open snapshot set — the
  // gallery is where you are actually looking at a camera, so it is where you
  // can tell which one needs a name. Seeded from the saved names so an
  // untouched field saves unchanged.
  const [nameDraft, setNameDraft] = useState<CameraNames | null>(null);
  const [savingNames, setSavingNames] = useState(false);

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
    if (gallery && !el.open) el.showModal();
    if (!gallery && el.open) el.close();
  }, [gallery]);

  // Closing the gallery abandons an open rename panel, so re-opening it never
  // shows another snapshot's half-typed draft.
  useEffect(() => {
    if (!gallery) setNameDraft(null);
  }, [gallery]);

  // Names come straight off the live project doc (ProjectProvider keeps an
  // onSnapshot on it), so a save re-renders the labels with no refetch here.
  const cameraNames = project?.cameraNames;

  /** Merge the draft over the saved names and persist. Channels outside the
   *  open snapshot set are untouched: the draft only ever holds the ones on
   *  screen, so editing a two-camera trigger cannot wipe camera 7's name. */
  const handleSaveNames = async () => {
    if (!projectId || !nameDraft) return;
    setSavingNames(true);
    try {
      const merged = normalizeCameraNames({ ...cameraNames, ...nameDraft });
      await updateDoc(projectDoc(projectId), { cameraNames: merged });
      setNameDraft(null);
    } finally {
      setSavingNames(false);
    }
  };

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

  // Build the set of timeline keys that already have a matching event row.
  // Timeline entries with no match are manual captures (rfId="MANUAL") or
  // orphans — surface them as standalone rows so manual captures are visible.
  const eventKeys = new Set(events.map((ev) => `${ev.rfId}_${ev.timestamp.toMillis()}`));
  const orphanTimeline = Array.from(timelineById.values()).filter(
    (tl) => tl.timestamp && !eventKeys.has(tl.id)
  );

  // Unified row type: real event or orphan timeline entry.
  type Row =
    | { kind: "event"; ev: AlarmEvent }
    | { kind: "timeline"; tl: TimelineSnapshotDoc };

  const rows: Row[] = [
    ...events.map((ev): Row => ({ kind: "event", ev })),
    ...orphanTimeline.map((tl): Row => ({ kind: "timeline", tl })),
  ].sort((a, b) => {
    const tsA = a.kind === "event" ? a.ev.timestamp.toMillis() : a.tl.timestamp!.toMillis();
    const tsB = b.kind === "event" ? b.ev.timestamp.toMillis() : b.tl.timestamp!.toMillis();
    return tsB - tsA; // newest first
  });

  const rowDayGroups = groupItemsByDay(
    rows,
    (r) => r.kind === "event" ? r.ev.timestamp.toMillis() : r.tl.timestamp!.toMillis(),
    now
  );

  const eventDayGroups = rowDayGroups;

  if (!project) {
    return <p>{t("ops.noProject")}</p>;
  }

  return (
    <div>
      <h1 className="sr-only">{t("explore.title")}</h1>

      <div className="card">
        {loading ? (
          <p>{t("explore.loading")}</p>
        ) : rows.length === 0 ? (
          <p className="muted">{t("explore.noEvents")}</p>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>{t("explore.timestamp")}</th>
                  <th>{t("explore.sensor")}</th>
                  <th>{t("explore.event")}</th>
                  {/* Camera sits next to the event, not after the radio
                      columns: a photo is what you want to see immediately
                      after reading WHAT happened. Battery/RSSI are diagnostics
                      and belong further right. */}
                  <th>{t("explore.camera")}</th>
                  <th>{t("explore.batteryLow")}</th>
                  <th>{t("explore.rssi")}</th>
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
                    {group.items.map((row, i) => {
                      const ts = row.kind === "event"
                        ? row.ev.timestamp.toMillis()
                        : row.tl.timestamp!.toMillis();
                      const ago =
                        group === eventDayGroups[0] && i === 0
                          ? relativeSuffix(ts, now, t)
                          : null;

                      // Orphan timeline row (manual capture — no event in the
                      // events collection).
                      if (row.kind === "timeline") {
                        const tl = row.tl;
                        const { hasImages, verdictLabel } = snapshotSummary(tl);
                        const verdictKey: TranslationKey | undefined =
                          verdictLabel === "Confirmed breach (AI)"
                            ? "explore.verdict.breach"
                            : verdictLabel === "False positive (AI)"
                              ? "explore.verdict.safe"
                              : undefined;
                        return (
                          <tr key={tl.id}>
                            <td>
                              <span className="ltr">{timeOfDaySeconds(ts)}</span>
                              {ago && <span className="muted"> ({ago})</span>}
                            </td>
                            <td>{tl.sensorName ?? "—"}</td>
                            <td>{t("explore.eventType.manual_capture" as TranslationKey)}</td>
                            <td>
                              {hasImages ? (
                                <div className="row" style={{ gap: "var(--sp-2)", alignItems: "center" }}>
                                  <button
                                    type="button"
                                    className="btn btn--sm"
                                    onClick={() =>
                                      setGallery({
                                        snapshots: tl.snapshots!,
                                        index: 0,
                                      })
                                    }
                                  >
                                    {t("explore.browseSnapshots", {
                                      count: tl.snapshots!.length,
                                    })}
                                  </button>
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
                            <td>{"—"}</td>
                            <td>{"—"}</td>
                          </tr>
                        );
                      }

                      // Normal event row.
                      const ev = row.ev;
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
                          <td>
                            <span className="ltr">{timeOfDaySeconds(ts)}</span>
                            {ago && <span className="muted"> ({ago})</span>}
                          </td>
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
                          <td>
                            {hasImages ? (
                              <div className="row" style={{ gap: "var(--sp-2)", alignItems: "center" }}>
                                <button
                                  type="button"
                                  className="btn btn--sm"
                                  onClick={() =>
                                    setGallery({
                                      snapshots: timelineEntry!.snapshots!,
                                      index: 0,
                                    })
                                  }
                                >
                                  {t("explore.browseSnapshots", {
                                    count: timelineEntry!.snapshots!.length,
                                  })}
                                </button>
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
                : t("explore.loadedCount", { count: rows.length })}
            </span>
          </div>
        )}
      </div>

      {/* Gallery modal: Browse button opens this; prev/next navigate channels;
          Esc or the close button dismisses it. */}
      <dialog
        ref={lightboxRef}
        className="modal"
        onClose={() => setGallery(null)}
        onClick={(e) => {
          if (e.target === e.currentTarget) setGallery(null);
        }}
      >
        {gallery && (
          <div className="modal__body" style={{ minWidth: "min(90vw, 600px)" }}>
            <div className="row" style={{ justifyContent: "space-between", marginBottom: "var(--sp-2)" }}>
              <div className="row" style={{ gap: "var(--sp-2)" }}>
                {gallery.snapshots.map((snap, i) => (
                  <button
                    key={snap.channel}
                    type="button"
                    className={"btn btn--sm" + (i === gallery.index ? " btn--active" : "")}
                    onClick={() => setGallery((g) => g && { ...g, index: i })}
                  >
                    {cameraLabel(cameraNames, snap.channel)}
                  </button>
                ))}
                {/* Rename lives HERE, next to the images, because this is the
                    only place you can see which camera is which. */}
                <button
                  type="button"
                  className={"btn btn--sm" + (nameDraft ? " btn--active" : "")}
                  onClick={() =>
                    setNameDraft((d) =>
                      d
                        ? null
                        : Object.fromEntries(
                            gallery.snapshots.map((s) => [
                              String(s.channel),
                              cameraNames?.[String(s.channel)] ?? "",
                            ])
                          )
                    )
                  }
                  aria-label={t("explore.renameCameras")}
                  title={t("explore.renameCameras")}
                >
                  ✏️
                </button>
              </div>
              <button
                type="button"
                className="btn btn--sm"
                onClick={() => setGallery(null)}
                aria-label={t("common.close")}
              >
                ✕
              </button>
            </div>

            {nameDraft && (
              <form
                className="stack"
                style={{ marginBottom: "var(--sp-3)", gap: "var(--sp-2)" }}
                onSubmit={(e) => {
                  e.preventDefault();
                  void handleSaveNames();
                }}
              >
                {gallery.snapshots.map((snap) => (
                  <label key={snap.channel} className="row" style={{ gap: "var(--sp-2)" }}>
                    <span className="muted" style={{ minWidth: "5rem" }}>
                      {t("explore.snapshotAlt", { channel: snap.channel })}
                    </span>
                    <input
                      className="input"
                      value={nameDraft[String(snap.channel)] ?? ""}
                      placeholder={t("explore.cameraNamePlaceholder", {
                        channel: snap.channel,
                      })}
                      maxLength={40}
                      onChange={(e) =>
                        setNameDraft((d) =>
                          d ? { ...d, [String(snap.channel)]: e.target.value } : d
                        )
                      }
                    />
                  </label>
                ))}
                <div className="row" style={{ gap: "var(--sp-2)" }}>
                  <button type="submit" className="btn btn--sm" disabled={savingNames}>
                    {t("explore.saveNames")}
                  </button>
                  <button
                    type="button"
                    className="btn btn--sm"
                    onClick={() => setNameDraft(null)}
                  >
                    {t("common.cancel")}
                  </button>
                </div>
              </form>
            )}

            <img
              src={gallery.snapshots[gallery.index].url}
              alt={cameraLabel(cameraNames, gallery.snapshots[gallery.index].channel)}
              style={{ maxWidth: "100%", maxHeight: "70vh", display: "block", margin: "0 auto" }}
            />
          </div>
        )}
      </dialog>
    </div>
  );
}
