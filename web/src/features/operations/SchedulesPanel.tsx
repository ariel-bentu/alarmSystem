// Schedules list, phone-alarm shaped: one compact row each, big time and a
// toggle, so the list stays scannable. The `+` opens the editor modal.
//
// This lives on Operations rather than Configure because "when does it
// disarm" is an operational question — the same kind of fact as "is it
// armed" — and you should not have to navigate away to answer it.
import { useEffect, useState } from "react";
import {
  addDoc,
  deleteDoc,
  onSnapshot,
  setDoc,
  Timestamp,
} from "firebase/firestore";
import { schedulesCol, scheduleDoc } from "@/lib/firestore";
import { useT } from "@/i18n/I18nProvider";
import { formatTimeRange, formatRecurrence } from "./scheduleFormat";
import ScheduleEditor from "./ScheduleEditor";
import type { TranslationKey } from "@/i18n/en";
import type { Schedule, Profile, Role } from "@/types";

interface Props {
  projectId: string;
  profiles: Profile[];
  role: Role | null;
}

export default function SchedulesPanel({ projectId, profiles, role }: Props) {
  const t = useT();
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [editing, setEditing] = useState<Schedule | null>(null);
  const [isNew, setIsNew] = useState(false);

  const isAdmin = role === "admin";

  useEffect(() => {
    const unsub = onSnapshot(schedulesCol(projectId), (snap) => {
      setSchedules(snap.docs.map((d) => d.data()));
    });
    return unsub;
  }, [projectId]);

  // Operations hides the Server card from non-admins, so a server schedule is
  // hidden from them too — same boundary, stated in one place.
  const visible = schedules.filter((s) => isAdmin || s.side === "device");

  // The header carries the single next edge in plain language. Read straight
  // off the precomputed timestamps, which is the second thing they buy.
  const nextLine = (): string => {
    let best: { at: Timestamp; text: string } | null = null;
    for (const s of visible) {
      if (!s.enabled) continue;
      const sideLabel = t(`sched.side.${s.side}` as TranslationKey);
      const candidates: Array<[Timestamp | null, string]> = [
        [s.nextArmAt, t("sched.nextArm", { side: sideLabel, when: s.armTime ?? "" })],
        [s.nextDisarmAt, t("sched.nextDisarm", { side: sideLabel, when: s.disarmTime })],
      ];
      for (const [at, text] of candidates) {
        if (!at) continue;
        if (!best || at.toMillis() < best.at.toMillis()) best = { at, text };
      }
    }
    return best ? best.text : t("sched.nextNone");
  };

  const blankSchedule = (): Schedule => ({
    id: "",
    name: "",
    enabled: true,
    side: "device",
    profileId: profiles[0]?.id ?? "",
    armTime: "23:00",
    disarmTime: "07:00",
    days: [0, 1, 2, 3, 4, 5, 6],
    date: null,
    nextArmAt: null,
    nextDisarmAt: null,
    lastFiredAt: null,
    createdAt: Timestamp.now(),
  });

  const handleSave = async (draft: Schedule) => {
    if (isNew) {
      // The converter strips `id` on write, and addDoc assigns one.
      await addDoc(schedulesCol(projectId), draft);
    } else {
      await setDoc(scheduleDoc(projectId, draft.id), draft);
    }
    setEditing(null);
  };

  const handleDelete = async () => {
    if (editing && !isNew) {
      await deleteDoc(scheduleDoc(projectId, editing.id));
    }
    setEditing(null);
  };

  // The toggle is the control most often reached for ("skip tonight"), so it
  // must never open the editor. It is a SIBLING of the row button rather than
  // nested inside it — nesting would make every toggle tap also a row tap.
  const handleToggle = async (s: Schedule, next: boolean) => {
    await setDoc(scheduleDoc(projectId, s.id), { ...s, enabled: next });
  };

  return (
    <section className="card">
      <div className="card__header">
        <h2 className="card__title">{t("sched.title")}</h2>
        <span className="muted">{t("sched.next", { what: nextLine() })}</span>
      </div>

      {visible.length === 0 && <p className="muted">{t("sched.none")}</p>}

      <ul className="sched-list">
        {visible.map((s) => {
          const profile = profiles.find((p) => p.id === s.profileId);
          const canToggle = isAdmin || s.side === "device";
          return (
            <li key={s.id}>
              <button
                className="sched-row"
                onClick={() => {
                  if (!isAdmin) return;
                  setIsNew(false);
                  setEditing(s);
                }}
                disabled={!isAdmin}
              >
                <span className="sched-row__time">
                  {formatTimeRange(s.armTime, s.disarmTime)}
                </span>
                <span className="sched-row__meta">
                  {[
                    s.armTime ? profile?.displayName : t("sched.disarmOnly"),
                    t(`sched.side.${s.side}` as TranslationKey),
                    formatRecurrence(
                      s.days,
                      s.date,
                      [0, 1, 2, 3, 4, 5, 6].map((d) =>
                        t(`sched.day.${d}` as TranslationKey)
                      ),
                      t("sched.everyDay")
                    ),
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </span>
              </button>
              <label className="check">
                <input
                  type="checkbox"
                  checked={s.enabled}
                  disabled={!canToggle}
                  aria-label={s.enabled ? t("sched.disable") : t("sched.enable")}
                  onChange={(e) => void handleToggle(s, e.target.checked)}
                />
              </label>
            </li>
          );
        })}
      </ul>

      {isAdmin && (
        <button
          className="btn"
          onClick={() => {
            setIsNew(true);
            setEditing(blankSchedule());
          }}
        >
          + {t("sched.add")}
        </button>
      )}

      {editing && (
        <ScheduleEditor
          schedule={editing}
          profiles={profiles}
          existing={schedules}
          isNew={isNew}
          onSave={(d) => void handleSave(d)}
          onCancel={() => setEditing(null)}
          onDelete={() => void handleDelete()}
        />
      )}
    </section>
  );
}
