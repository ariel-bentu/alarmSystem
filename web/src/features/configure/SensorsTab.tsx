import { Fragment, useState, useEffect, useRef } from "react";
import {
  ref,
  onValue,
  DataSnapshot,
} from "firebase/database";
import {
  getDocs,
  addDoc,
  deleteDoc,
  updateDoc,
  Timestamp,
} from "firebase/firestore";
import { rtdbSync } from "@/lib/firebase";
import {
  sensorsCol,
  sensorDoc,
  profilesCol,
  rulesCol,
  ruleDoc,
} from "@/lib/firestore";
import { useProject } from "@/app/ProjectProvider";
import type { Sensor, Profile, Rule } from "@/types";
import { getUnknownRfIds } from "./unknownSensors";
import {
  effectiveLastSeen,
  isJustSeen,
  sortByLastSeenDesc,
  type EventTiming,
} from "./sensorRecency";
import {
  buildInitialRules,
  reconcileRulesForRemovedSensor,
} from "./profileRules";
import { formatRelative, timeOfDay } from "./lastSeenFormat";
import {
  batteryStartedAt,
  formatBatteryAge,
  isBatteryStale,
  toDateInputValue,
  fromDateInputValue,
  DEFAULT_BATTERY_ALERT_MONTHS,
} from "./batteryAge";
import { groupItemsByDay } from "./groupSensorsByDay";
import { DayHeaderRow } from "@/components/DayHeaderRow";
import { useT } from "@/i18n/I18nProvider";

interface PairFormState {
  rfId: string;
  name: string;
}

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

export default function SensorsTab() {
  const t = useT();
  const { project } = useProject();
  const projectId = project?.id ?? "";

  const [sensors, setSensors] = useState<Sensor[]>([]);
  const [eventTiming, setEventTiming] = useState<Record<string, EventTiming>>({});
  const [pairForm, setPairForm] = useState<PairFormState | null>(null);
  const [pairName, setPairName] = useState("");
  const [loading, setLoading] = useState(true);
  const [now, setNow] = useState(() => Date.now());
  const [olderExpanded, setOlderExpanded] = useState(false);
  // Profiles are loaded only to offer "add a rule to every profile" when
  // pairing, and to say how many that is.
  const [profiles, setProfiles] = useState<Profile[]>([]);
  // Defaults ON: a freshly paired sensor that triggers nothing is the
  // surprising outcome, and the alternative is hunting through every profile
  // to add the same immediate rule by hand.
  const [addToProfiles, setAddToProfiles] = useState(true);
  const pairDialogRef = useRef<HTMLDialogElement>(null);

  // Every close path goes through here, so Esc and the backdrop cannot leave
  // a stale name or a flipped checkbox behind for the next sensor.
  const closePairForm = () => {
    setPairForm(null);
    setPairName("");
    setAddToProfiles(true);
  };

  // Driven imperatively because showModal() is the only way to get the top
  // layer, the ::backdrop, focus trapping and Esc-to-close — none of which
  // happen if the element is merely rendered with an `open` attribute.
  useEffect(() => {
    const el = pairDialogRef.current;
    if (!el) return;
    if (pairForm && !el.open) el.showModal();
    if (!pairForm && el.open) el.close();
  }, [pairForm]);

  // Keep `now` fresh so recency highlights update without a page reload.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 10_000);
    return () => clearInterval(id);
  }, []);

  // Load paired sensors from Firestore
  useEffect(() => {
    if (!projectId) return;
    let cancelled = false;
    async function load() {
      const snap = await getDocs(sensorsCol(projectId));
      if (!cancelled) {
        setSensors(snap.docs.map((d) => d.data()));
        setLoading(false);
      }
    }
    void load();
    return () => { cancelled = true; };
  }, [projectId]);

  // Profiles, for the pair dialog's "add a rule to every profile" option.
  useEffect(() => {
    if (!projectId) return;
    let cancelled = false;
    async function load() {
      const snap = await getDocs(profilesCol(projectId));
      if (!cancelled) setProfiles(snap.docs.map((d) => d.data()));
    }
    void load();
    return () => { cancelled = true; };
  }, [projectId]);

  // Subscribe to RTDB events. For each rfId, derive first/last seen + count.
  useEffect(() => {
    if (!projectId) return;
    const eventsRef = ref(rtdbSync(), `${projectId}/events`);
    const unsub = onValue(eventsRef, (snapshot: DataSnapshot) => {
      const val = snapshot.val();
      const timing: Record<string, EventTiming> = {};
      if (val && typeof val === "object") {
        for (const [rfId, events] of Object.entries(
          val as Record<string, Record<string, unknown>>
        )) {
          const tsKeys = Object.keys(events ?? {}).map(Number).filter((n) => !Number.isNaN(n));
          if (tsKeys.length === 0) continue;
          timing[rfId] = {
            firstSeen: Math.min(...tsKeys),
            lastSeen: Math.max(...tsKeys),
            count: tsKeys.length,
          };
        }
      }
      setEventTiming(timing);
    });
    return () => unsub();
  }, [projectId]);

  const eventRfIds = Object.keys(eventTiming);
  const knownRfIds = sensors.map((s) => s.rfId);
  const unknownRfIds = getUnknownRfIds(eventRfIds, knownRfIds);

  // Paired sensors: last seen is the newer of the live RTDB event and the
  // Firestore field, so the table updates as events arrive.
  const pairedLastSeen = (s: Sensor) =>
    effectiveLastSeen(s.rfId, eventTiming, s.lastSeen?.toMillis() ?? null);
  // Rows are grouped under day headings by when each sensor was last seen;
  // groupItemsByDay sorts both the days and the rows within them.
  const sensorDayGroups = groupItemsByDay(sensors, pairedLastSeen, now);

  // Sort unknown sensors by last seen descending (most recent first).
  const sortedUnknownRfIds = sortByLastSeenDesc(
    unknownRfIds,
    (rfId) => eventTiming[rfId]?.lastSeen ?? null
  );

  const recentUnknown = sortedUnknownRfIds.filter(
    (id) => now - (eventTiming[id]?.lastSeen ?? 0) <= ONE_DAY_MS
  );
  const olderUnknown = sortedUnknownRfIds.filter(
    (id) => now - (eventTiming[id]?.lastSeen ?? 0) > ONE_DAY_MS
  );

  const handlePair = async () => {
    if (!pairForm || !pairName.trim() || !projectId) return;
    const newSensor: Omit<Sensor, "id"> = {
      rfId: pairForm.rfId,
      name: pairName.trim(),
      pairedAt: Timestamp.now(),
      batteryStatus: "ok",
      lastSeen: null,
      deadSensorAlertDays: -1,
      deadAlertSentAt: null,
      // Explicitly null rather than "today": pairing a sensor is not evidence
      // about its battery, and batteryStartedAt() already falls back to
      // pairedAt, which is the same instant and needs no maintenance.
      batteryChangedAt: null,
      batteryAlertSentAt: null,
    };
    // NOT named `ref`: that is the firebase/database import used by the events
    // subscription above, and shadowing it here is a trap for the next edit.
    const sensorRef = await addDoc(sensorsCol(projectId), newSensor as Sensor);

    // Give the sensor an immediate rule in every profile. Without one a paired
    // sensor is inert: it appears in the list and logs events, but no profile
    // references it, so arming does nothing with it. This mirrors what
    // buildInitialRules does when a profile is created — same shape, opposite
    // direction — so the two paths cannot drift.
    //
    // Rules are OR'd and a sensor may appear in several, so adding one here
    // never conflicts with a rule the user writes later.
    if (addToProfiles && profiles.length > 0) {
      const [rule] = buildInitialRules([sensorRef.id]);
      await Promise.all(
        profiles.map((p) => addDoc(rulesCol(projectId, p.id), rule as Rule))
      );
    }

    const snap = await getDocs(sensorsCol(projectId));
    setSensors(snap.docs.map((d) => d.data()));
    closePairForm();
  };

  const handleUnpair = async (sensor: Sensor) => {
    if (!projectId) return;

    const profilesSnap = await getDocs(profilesCol(projectId));
    const plans: {
      profileId: string;
      recon: ReturnType<typeof reconcileRulesForRemovedSensor>;
    }[] = [];
    for (const p of profilesSnap.docs) {
      const rulesSnap = await getDocs(rulesCol(projectId, p.id));
      const rules = rulesSnap.docs.map((d) => d.data());
      const recon = reconcileRulesForRemovedSensor(rules, sensor.id);
      if (recon.toDelete.length || recon.toUpdate.length) {
        plans.push({ profileId: p.id, recon });
      }
    }

    const deletes = plans.reduce((n, p) => n + p.recon.toDelete.length, 0);
    const updates = plans.reduce((n, p) => n + p.recon.toUpdate.length, 0);
    const impact =
      deletes || updates
        ? t("cfg.sensors.unpairImpact", { updates, deletes })
        : "";
    if (
      !window.confirm(
        t("cfg.sensors.unpairConfirm", {
          name: sensor.name,
          rfId: sensor.rfId,
          impact,
        })
      )
    ) {
      return;
    }

    for (const plan of plans) {
      for (const r of plan.recon.toDelete) {
        await deleteDoc(ruleDoc(projectId, plan.profileId, r.id));
      }
      for (const r of plan.recon.toUpdate) {
        await updateDoc(ruleDoc(projectId, plan.profileId, r.id), {
          sensors: r.sensors,
          condition: r.condition,
        });
      }
    }

    await deleteDoc(sensorDoc(projectId, sensor.id));
    const snap = await getDocs(sensorsCol(projectId));
    setSensors(snap.docs.map((d) => d.data()));
  };

  const handleDeadAlertDaysChange = async (sensor: Sensor, days: number) => {
    if (!projectId) return;
    await updateDoc(sensorDoc(projectId, sensor.id), { deadSensorAlertDays: days });
    setSensors((prev) =>
      prev.map((s) => s.id === sensor.id ? { ...s, deadSensorAlertDays: days } : s)
    );
  };

  // Recording a replacement ALSO clears batteryAlertSentAt. That pairing is
  // what re-arms the alert for the next cycle — without it each sensor would
  // Telegram once, ever, and go quiet for every battery after the first.
  const handleBatteryChangedAt = async (sensor: Sensor, ms: number) => {
    if (!projectId) return;
    const changed = Timestamp.fromMillis(ms);
    await updateDoc(sensorDoc(projectId, sensor.id), {
      batteryChangedAt: changed,
      batteryAlertSentAt: null,
    });
    setSensors((prev) =>
      prev.map((s) =>
        s.id === sensor.id
          ? { ...s, batteryChangedAt: changed, batteryAlertSentAt: null }
          : s
      )
    );
  };

  if (loading) return <p>{t("cfg.sensors.loading")}</p>;

  // One row of the unrecognised-sensor tables. Shared so the "recent" and
  // "older" tables cannot drift apart.
  const UnknownRow = ({
    rfId,
    fresh,
    relative,
  }: {
    rfId: string;
    fresh: boolean;
    relative: boolean;
  }) => {
    const timing = eventTiming[rfId];
    const justSeen = fresh && isJustSeen(timing?.lastSeen ?? null, now);
    return (
      <tr className={justSeen ? "is-fresh" : undefined}>
        <td>
          {justSeen && <span className="dot dot--fresh" />}
          <span className="ltr">{rfId}</span>
        </td>
        <td>
          {!timing
            ? "—"
            : relative
              ? formatRelative(timing.lastSeen, now, t)
              : timeOfDay(timing.lastSeen)}
        </td>
        <td>{timing?.count ?? 0}</td>
        <td>
          <button
            className="btn btn--sm btn--primary"
            onClick={() => {
              setPairForm({ rfId, name: "" });
              setPairName("");
            }}
          >
            {t("cfg.sensors.pair")}
          </button>
        </td>
      </tr>
    );
  };

  const UNKNOWN_COLS = 4;

  const UnknownHead = () => (
    <thead>
      <tr>
        <th>{t("cfg.sensors.rfId")}</th>
        <th>{t("cfg.sensors.lastSeen")}</th>
        <th>{t("cfg.sensors.events")}</th>
        <th />
      </tr>
    </thead>
  );

  // Day-grouped body, shared by the recent and older unrecognised tables.
  const UnknownBody = ({ rfIds, fresh }: { rfIds: string[]; fresh: boolean }) => {
    const groups = groupItemsByDay(
      rfIds,
      (rfId) => eventTiming[rfId]?.lastSeen ?? null,
      now
    );
    return (
      <tbody>
        {groups.map((group) => (
          <Fragment key={group.dayKey}>
            <DayHeaderRow
              date={group.date}
              isToday={group.isToday}
              isNever={group.isNever}
              colSpan={UNKNOWN_COLS}
            />
            {group.items.map((rfId) => (
              <UnknownRow
                key={rfId}
                rfId={rfId}
                fresh={fresh}
                // Only today's rows need relative phrasing; on an earlier day
                // the heading already carries the date, so a bare clock time
                // is enough and avoids repeating "28.08" on every row.
                relative={group.isToday}
              />
            ))}
          </Fragment>
        ))}
      </tbody>
    );
  };

  return (
    <div>
      <section className="card">
        <div className="card__header">
          <h2 className="card__title">{t("cfg.sensors.paired")}</h2>
        </div>
        {sensors.length === 0 ? (
          <p className="muted">{t("cfg.sensors.nonePaired")}</p>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>{t("cfg.sensors.name")}</th>
                  <th>{t("cfg.sensors.lastSeen")}</th>
                  <th>{t("cfg.sensors.battery")}</th>
                  <th title={t("cfg.sensors.alertAfterDaysHelp")}>
                    {t("cfg.sensors.alertAfterDays")}
                  </th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {sensorDayGroups.map((group) => (
                  <Fragment key={group.dayKey}>
                    {/* Sensors appear once, under the day they were last seen. */}
                    <DayHeaderRow
                      date={group.date}
                      isToday={group.isToday}
                      isNever={group.isNever}
                      colSpan={5}
                    />
                    {group.items.map((s) => {
                  const lastSeen = pairedLastSeen(s);
                  const justSeen = isJustSeen(lastSeen, now);
                  return (
                    <tr key={s.id} className={justSeen ? "is-fresh" : undefined}>
                      <td>
                        {justSeen && <span className="dot dot--fresh" />}
                        {s.name}
                      </td>
                      <td>
                        {lastSeen === null ? (
                          <span className="muted">{t("common.never")}</span>
                        ) : group.isToday ? (
                          formatRelative(lastSeen, now, t)
                        ) : (
                          timeOfDay(lastSeen)
                        )}
                      </td>
                      <td>
                        {s.batteryStatus === "low" ? (
                          <span className="badge badge--danger">
                            {t("cfg.sensors.batteryLow")}
                          </span>
                        ) : (
                          <span className="badge">
                            {t("cfg.sensors.batteryOk")}
                          </span>
                        )}
                        {/* Age sits under the sensor's own ok/low claim
                            because they are the same subject seen two ways:
                            what the sensor reports, and what we recorded.
                            Sharing the cell also keeps the table at five
                            columns, which is as wide as it fits on a phone. */}
                        <div className="battery-age">
                          {(() => {
                            const startedAt = batteryStartedAt(s);
                            const age = formatBatteryAge(startedAt, now, t);
                            const stale = isBatteryStale(
                              startedAt,
                              now,
                              project?.batteryAlertMonths ??
                                DEFAULT_BATTERY_ALERT_MONTHS
                            );
                            if (age === null) {
                              return (
                                <span className="muted">
                                  {t("cfg.sensors.batteryNotRecorded")}
                                </span>
                              );
                            }
                            return (
                              <span className={stale ? "is-stale" : "muted"}>
                                {age}
                                {stale
                                  ? ` — ${t("cfg.sensors.batteryStale")}`
                                  : ""}
                              </span>
                            );
                          })()}
                          <div className="battery-age__controls">
                            <input
                              type="date"
                              className="input input--narrow"
                              max={toDateInputValue(now)}
                              value={
                                s.batteryChangedAt
                                  ? toDateInputValue(
                                      s.batteryChangedAt.toMillis()
                                    )
                                  : ""
                              }
                              onChange={(e) => {
                                // A null return means empty, malformed or
                                // future: leave the stored value untouched
                                // rather than writing nonsense, the same way
                                // the alert-days input ignores NaN.
                                const ms = fromDateInputValue(
                                  e.target.value,
                                  now
                                );
                                if (ms !== null)
                                  void handleBatteryChangedAt(s, ms);
                              }}
                              aria-label={t("cfg.sensors.batteryChangedLabel")}
                            />
                            <button
                              type="button"
                              className="btn btn--sm"
                              onClick={() =>
                                void handleBatteryChangedAt(s, Date.now())
                              }
                            >
                              {t("cfg.sensors.batteryTodayButton")}
                            </button>
                          </div>
                        </div>
                      </td>
                      <td>
                        <input
                          type="number"
                          min={-1}
                          className="input input--narrow"
                          value={s.deadSensorAlertDays ?? -1}
                          onChange={(e) => {
                            const v = parseInt(e.target.value, 10);
                            if (!Number.isNaN(v))
                              void handleDeadAlertDaysChange(s, v);
                          }}
                          title={t("cfg.sensors.neverAlert")}
                          aria-label={t("cfg.sensors.alertAfterDays")}
                        />
                      </td>
                      <td>
                        <button
                          type="button"
                          className="btn btn--sm"
                          onClick={() => void handleUnpair(s)}
                        >
                          {t("cfg.sensors.unpair")}
                        </button>
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
      </section>

      <section className="card">
        <div className="card__header">
          <h2 className="card__title">{t("cfg.sensors.unrecognised")}</h2>
        </div>

        {unknownRfIds.length === 0 ? (
          <div className="muted">
            <p>{t("cfg.sensors.noneSeen")}</p>
            <p>{t("cfg.sensors.noneSeenBody")}</p>
            <p>
              {t("cfg.sensors.wrongProjectHint", {
                projectId: projectId || t("common.none"),
              })}
            </p>
          </div>
        ) : (
          <>
            <p className="muted">{t("cfg.sensors.unrecognisedHint")}</p>
            <div className="table-wrap">
              <table className="table">
                <UnknownHead />
                <UnknownBody rfIds={recentUnknown} fresh />
              </table>
            </div>

            {olderUnknown.length > 0 && (
              <div>
                <button
                  type="button"
                  className="btn btn--ghost btn--sm"
                  onClick={() => setOlderExpanded((v) => !v)}
                  aria-expanded={olderExpanded}
                >
                  {olderExpanded ? "▾" : "▸"}{" "}
                  {t("cfg.sensors.olderSensors", { count: olderUnknown.length })}
                </button>
                {olderExpanded && (
                  <div className="table-wrap">
                    <table className="table">
                      <UnknownHead />
                      <UnknownBody rfIds={olderUnknown} fresh={false} />
                    </table>
                  </div>
                )}
              </div>
            )}
          </>
        )}
      </section>

      {/* A modal, not a card appended to the page. Rendered inline it landed
          BELOW the sensor list — frequently off-screen — so tapping Pair on a
          row looked like nothing had happened, and the form was visually
          detached from the row it belonged to.
          `onCancel` covers Esc and `onClose` the backdrop//form-method=dialog
          paths, so state can never disagree with what is on screen. */}
      <dialog
        ref={pairDialogRef}
        className="modal"
        onCancel={closePairForm}
        onClose={closePairForm}
      >
        {pairForm && (
          <form
            method="dialog"
            className="modal__body"
            onSubmit={(e) => {
              e.preventDefault();
              void handlePair();
            }}
          >
            <h3 className="card__title">
              {t("cfg.sensors.pairTitle", { rfId: pairForm.rfId })}
            </h3>
            <div className="field">
              <label className="field__label" htmlFor="pair-name">
                {t("cfg.sensors.name")}
              </label>
              {/* autoFocus is right here: the dialog exists solely to collect
                  this one value, and it opens in response to a deliberate tap. */}
              <input
                id="pair-name"
                className="input"
                type="text"
                value={pairName}
                autoFocus
                onChange={(e) => setPairName(e.target.value)}
                placeholder={t("cfg.sensors.namePlaceholder")}
              />
            </div>

            {/* Hidden entirely when there are no profiles: an unticked box
                with nothing to apply to is a puzzle, so say why instead. */}
            {profiles.length > 0 ? (
              <div className="field">
                <label className="check">
                  <input
                    type="checkbox"
                    checked={addToProfiles}
                    onChange={(e) => setAddToProfiles(e.target.checked)}
                  />
                  <span>{t("cfg.sensors.addToProfiles")}</span>
                </label>
                <p className="muted">
                  {t("cfg.sensors.addToProfilesHelp", {
                    count: profiles.length,
                  })}
                </p>
              </div>
            ) : (
              <p className="muted">{t("cfg.sensors.addToProfilesNone")}</p>
            )}

            <div className="row">
              <button
                type="submit"
                className="btn btn--primary"
                disabled={!pairName.trim()}
              >
                {t("common.save")}
              </button>
              <button
                type="button"
                className="btn"
                onClick={closePairForm}
              >
                {t("common.cancel")}
              </button>
            </div>
          </form>
        )}
      </dialog>
    </div>
  );
}
