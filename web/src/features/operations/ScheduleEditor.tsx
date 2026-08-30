// Modal editor for one schedule. Presentational: it owns draft state and
// validation only — the parent persists, so this stays testable and the
// Firestore calls live in one place.
//
// A <dialog> opened with showModal() is what gives the top layer, backdrop,
// focus trap and Esc handling; rendering with `open` does none of that. Same
// pattern as ProfilesTab's rule dialogs.
import { useEffect, useRef, useState } from "react";
import { useT } from "@/i18n/I18nProvider";
import { findOverlaps } from "./scheduleOverlap";
import type { TranslationKey } from "@/i18n/en";
import type { Schedule, Profile } from "@/types";

interface Props {
  schedule: Schedule; // a fully-formed draft, new or existing
  profiles: Profile[];
  existing: Schedule[]; // for the overlap warning
  isNew: boolean;
  onSave: (draft: Schedule) => void;
  onCancel: () => void;
  onDelete: () => void;
}

const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];

export default function ScheduleEditor({
  schedule,
  profiles,
  existing,
  isNew,
  onSave,
  onCancel,
  onDelete,
}: Props) {
  const t = useT();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [draft, setDraft] = useState<Schedule>(schedule);

  useEffect(() => {
    const el = dialogRef.current;
    if (el && !el.open) el.showModal();
  }, []);

  const set = <K extends keyof Schedule>(key: K, value: Schedule[K]) =>
    setDraft((d) => ({ ...d, [key]: value }));

  const toggleDay = (day: number) =>
    setDraft((d) => ({
      ...d,
      days: d.days.includes(day)
        ? d.days.filter((x) => x !== day)
        : [...d.days, day],
    }));

  const isOnce = draft.date !== null;
  const conflicts = findOverlaps(draft, existing);
  const targetProfile = profiles.find((p) => p.id === draft.profileId);
  const profileDisabled = targetProfile ? targetProfile.enabled === false : false;

  // A window must close, and a recurring one must say when.
  const valid =
    draft.disarmTime !== "" &&
    draft.profileId !== "" &&
    (isOnce ? draft.date !== "" : draft.days.length > 0);

  return (
    <dialog
      ref={dialogRef}
      className="modal"
      onCancel={onCancel}
      onClose={onCancel}
    >
      <div className="modal__body">
        <h3 className="card__title">
          {isNew ? t("sched.add") : t("sched.edit")}
        </h3>

        <div className="field">
          <label className="field__label" htmlFor="sched-name">
            {t("sched.name")}
          </label>
          <input
            id="sched-name"
            className="input"
            type="text"
            value={draft.name}
            onChange={(e) => set("name", e.target.value)}
          />
        </div>

        <div className="field">
          <label className="field__label" htmlFor="sched-side">
            {t("sched.side")}
          </label>
          <select
            id="sched-side"
            className="input"
            value={draft.side}
            onChange={(e) => set("side", e.target.value as Schedule["side"])}
          >
            <option value="device">{t("sched.side.device")}</option>
            <option value="server">{t("sched.side.server")}</option>
          </select>
        </div>

        <div className="field">
          <label className="field__label" htmlFor="sched-profile">
            {t("sched.profile")}
          </label>
          <select
            id="sched-profile"
            className="input"
            value={draft.profileId}
            onChange={(e) => set("profileId", e.target.value)}
          >
            {profiles.map((p) => (
              <option key={p.id} value={p.id}>
                {p.displayName}
              </option>
            ))}
          </select>
          {profileDisabled && (
            <p className="muted">{t("sched.disabledProfile")}</p>
          )}
        </div>

        <div className="field">
          <label className="field__label" htmlFor="sched-arm">
            {t("sched.armTime")}
          </label>
          <input
            id="sched-arm"
            className="input"
            type="time"
            value={draft.armTime ?? ""}
            onChange={(e) => set("armTime", e.target.value || null)}
          />
          <p className="muted">{t("sched.armOptional")}</p>
        </div>

        <div className="field">
          <label className="field__label" htmlFor="sched-disarm">
            {t("sched.disarmTime")}
          </label>
          <input
            id="sched-disarm"
            className="input"
            type="time"
            required
            value={draft.disarmTime}
            onChange={(e) => set("disarmTime", e.target.value)}
          />
        </div>

        <div className="field">
          <label className="field__label" htmlFor="sched-repeat">
            {t("sched.repeat")}
          </label>
          <select
            id="sched-repeat"
            className="input"
            value={isOnce ? "once" : "weekly"}
            onChange={(e) =>
              setDraft((d) =>
                e.target.value === "once"
                  ? {
                      ...d,
                      days: [],
                      date: d.date ?? new Date().toISOString().slice(0, 10),
                    }
                  : { ...d, date: null, days: d.days.length ? d.days : ALL_DAYS }
              )
            }
          >
            <option value="weekly">{t("sched.repeat.weekly")}</option>
            <option value="once">{t("sched.repeat.once")}</option>
          </select>
        </div>

        {isOnce ? (
          <div className="field">
            <label className="field__label" htmlFor="sched-date">
              {t("sched.date")}
            </label>
            <input
              id="sched-date"
              className="input"
              type="date"
              value={draft.date ?? ""}
              onChange={(e) => set("date", e.target.value)}
            />
          </div>
        ) : (
          <div className="field">
            <span className="field__label">{t("sched.repeat.weekly")}</span>
            <div className="day-toggles">
              {ALL_DAYS.map((d) => (
                <button
                  key={d}
                  type="button"
                  className={`day-toggle${draft.days.includes(d) ? " is-active" : ""}`}
                  aria-pressed={draft.days.includes(d)}
                  onClick={() => toggleDay(d)}
                >
                  {t(`sched.day.${d}` as TranslationKey)}
                </button>
              ))}
            </div>
          </div>
        )}

        {conflicts.length > 0 && (
          <p className="muted">{t("sched.overlapWarning")}</p>
        )}

        <div className="row">
          <button
            className="btn btn--primary"
            disabled={!valid}
            onClick={() => onSave(draft)}
          >
            {t("common.save")}
          </button>
          <button className="btn" onClick={onCancel}>
            {t("common.cancel")}
          </button>
          {!isNew && (
            <button className="btn btn--danger" onClick={onDelete}>
              {t("common.delete")}
            </button>
          )}
        </div>
      </div>
    </dialog>
  );
}
