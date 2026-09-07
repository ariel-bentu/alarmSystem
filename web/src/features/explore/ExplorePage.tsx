// Explore page: unified event timeline with time range selector.
import { Fragment, useEffect, useState } from "react";
import {
  onSnapshot,
  query,
  where,
  orderBy,
  limit,
  Timestamp,
} from "firebase/firestore";
import { useProject } from "@/app/ProjectProvider";
import { eventsCol } from "@/lib/firestore";
import { rangeCutoff } from "./timeRange";
import { eventSubject } from "./eventSubject";
import { ScrollingTabs } from "@/components/ScrollingTabs";
import { DayHeaderRow } from "@/components/DayHeaderRow";
import { groupItemsByDay } from "@/features/configure/groupSensorsByDay";
import {
  formatRelative,
  timeOfDay,
} from "@/features/configure/lastSeenFormat";
import { useT } from "@/i18n/I18nProvider";
import type { TranslationKey } from "@/i18n/en";
import type { AlarmEvent, TimeRange } from "@/types";

const TIME_RANGES: TimeRange[] = ["day", "week", "month", "3months", "year"];
const MAX_EVENTS = 500;

// Events that came from a physical RF packet, and therefore have a real
// battery flag and signal strength. Arm/disarm originate in the app.
const RADIO_EVENTS = new Set(["trigger", "tamper", "battery_low", "alarm"]);

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

  const [range, setRange] = useState<TimeRange>("day");
  const [events, setEvents] = useState<AlarmEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!projectId) {
      setEvents([]);
      setLoading(false);
      return;
    }

    setLoading(true);
    const cutoff = Timestamp.fromMillis(rangeCutoff(range, Date.now()));

    const q = query(
      eventsCol(projectId),
      where("timestamp", ">=", cutoff),
      orderBy("timestamp", "desc"),
      limit(MAX_EVENTS)
    );

    const unsub = onSnapshot(q, (snap) => {
      setEvents(snap.docs.map((d) => d.data()));
      setLoading(false);
    });

    return unsub;
  }, [projectId, range]);

  // Keeps the newest event's relative time honest without a reload.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 10_000);
    return () => clearInterval(id);
  }, []);

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

      {/* Time range selector — scrolls rather than wrapping on narrow screens */}
      <ScrollingTabs activeKey={range} ariaLabel={t("explore.title")}>
        {TIME_RANGES.map((r) => (
          <button
            key={r}
            type="button"
            role="tab"
            className="tab"
            aria-selected={r === range}
            onClick={() => setRange(r)}
          >
            {t(`explore.range.${r}` as TranslationKey)}
          </button>
        ))}
      </ScrollingTabs>

      <div className="card" style={{ marginBlockStart: "var(--sp-4)" }}>
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
                </tr>
              </thead>
              <tbody>
                {eventDayGroups.map((group) => (
                  <Fragment key={group.dayKey}>
                    <DayHeaderRow
                      date={group.date}
                      isToday={group.isToday}
                      isNever={group.isNever}
                      colSpan={5}
                    />
                    {group.items.map((ev, i) => {
                      const ts = ev.timestamp.toMillis();
                      return (
                        <tr
                          key={ev.id}
                          className={isSystemEvent(ev.eventType) ? "muted" : undefined}
                        >
                          {/* The date is already in the heading above, so rows
                              show only a time. The newest event overall gets
                              relative phrasing — it is the one being checked. */}
                          <td>
                            {group === eventDayGroups[0] && i === 0
                              ? formatRelative(ts, now, t)
                              : timeOfDay(ts)}
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
                        </tr>
                      );
                    })}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
